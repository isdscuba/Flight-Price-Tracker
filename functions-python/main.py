import os
import re
import logging
from datetime import datetime
from flask import Flask, request, jsonify
from fast_flights import FlightData, Passengers, get_flights

try:
    from fli.search import SearchFlights
    from fli.models import FlightSearchFilters, PassengerInfo as FliPassengerInfo, SeatType, Airport, MaxStops
    FLI_AVAILABLE = True
except ImportError:
    FLI_AVAILABLE = False
    logging.warning("fli (flights) package not installed — /fli-price will return null prices")

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

PRICE_SECRET = os.environ.get("PRICE_SECRET", "")
EXCLUDED_AIRLINES = {'frontier', 'spirit'}


def stops_int(f):
    """Safely get stops as int; handles 'Unknown' string."""
    try:
        return int(f.stops)
    except (ValueError, TypeError):
        return None


def parse_price(price_str):
    """Convert '$544' or '1,234' to float. Returns None if unparseable."""
    if not price_str:
        return None
    cleaned = re.sub(r"[^\d.]", "", str(price_str))
    try:
        val = float(cleaned)
        return val if val > 0 else None
    except (ValueError, TypeError):
        return None


def parse_flight_time(t_str):
    """Parse '2:45 PM' style time to datetime.time. Returns None if unparseable."""
    if not t_str:
        return None
    for fmt in ("%I:%M %p", "%I:%M%p", "%H:%M"):
        try:
            return datetime.strptime(t_str.strip(), fmt).time()
        except ValueError:
            continue
    return None


def parse_hhmm(t_str):
    """Parse 'HH:MM' (24h) from HTML time input to datetime.time."""
    if not t_str:
        return None
    try:
        return datetime.strptime(t_str, "%H:%M").time()
    except ValueError:
        return None


def duration_to_hrs(d_str):
    """Convert '7h 35m' to float hours. Returns inf if unparseable."""
    if not d_str:
        return float('inf')
    m = re.match(r'(?:(\d+)h\s*)?(?:(\d+)m)?', d_str.strip())
    if not m or (not m.group(1) and not m.group(2)):
        return float('inf')
    h = int(m.group(1) or 0)
    mn = int(m.group(2) or 0)
    return h + mn / 60


@app.route("/price", methods=["POST"])
def get_price():
    # Validate shared secret if configured
    if PRICE_SECRET and request.headers.get("X-Price-Secret") != PRICE_SECRET:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Missing JSON body"}), 400

    # Required fields
    origin_raw   = body.get("origin")       # str "JFK" OR list ["JFK","LGA","ISP"]
    destination  = body.get("destination")
    departure_date = body.get("departureDate")  # "YYYY-MM-DD"
    return_date    = body.get("returnDate")      # "YYYY-MM-DD" or null
    adults    = int(body.get("adults", 1))
    children  = int(body.get("children", 0))

    # Filter params
    stops_preference  = body.get("stopsPreference", "any")    # "direct"|"1stop"|"any"
    depart_after_str  = body.get("departureTimeStart")         # "HH:MM" or null
    depart_before_str = body.get("departureTimeEnd")           # "HH:MM" or null
    max_duration_hrs  = body.get("maxDurationHours")           # float or null

    if not all([origin_raw, destination, departure_date]):
        return jsonify({"error": "origin, destination, departureDate are required"}), 400

    # Normalise origin to a list
    if isinstance(origin_raw, list):
        origins = [o.strip().upper() for o in origin_raw if o.strip()]
    else:
        origins = [s.strip().upper() for s in str(origin_raw).split(',') if s.strip()]

    trip_type = "round-trip" if return_date else "one-way"
    # fast-flights children parameter produces severely limited/wrong results.
    # Treat all passengers as adults for accurate pricing; prices are per-person
    # so the total still reflects the correct group cost.
    total_passengers = adults + children
    passengers_obj = Passengers(adults=total_passengers)

    # Fetch flights from each origin and merge
    all_flights = []
    for orig in origins:
        try:
            flight_data_list = [FlightData(date=departure_date, from_airport=orig, to_airport=destination)]
            if return_date:
                flight_data_list.append(FlightData(date=return_date, from_airport=destination, to_airport=orig))

            result = get_flights(
                flight_data=flight_data_list,
                trip=trip_type,
                seat="economy",
                passengers=passengers_obj,
            )
            if result and result.flights:
                all_flights.extend(result.flights)
                logging.info(f"{orig}->{destination}: {len(result.flights)} flights fetched")
        except Exception as e:
            logging.warning(f"No results for {orig}->{destination}: {e}")

    flights = all_flights

    if not flights:
        logging.warning(f"No flights found for any origin -> {destination} on {departure_date}")
        return jsonify({"googlePrice": None, "priceLevel": None, "flightCount": 0, "flights": [], "topFlight": None})

    # ── Filters ────────────────────────────────────────────────────────────────

    # 0. Drop rows with no price OR no airline name (combo/aggregate rows have price but empty name)
    flights = [
        f for f in flights
        if getattr(f, 'price', None) and str(getattr(f, 'price', '')).strip()
        and getattr(f, 'name', None) and str(getattr(f, 'name', '')).strip()
    ]

    # 1. Always exclude Frontier and Spirit
    flights = [f for f in flights if not any(ex in str(getattr(f, 'name', '')).lower() for ex in EXCLUDED_AIRLINES)]

    # 2. Stops filter
    if stops_preference == 'direct':
        flights = [f for f in flights if stops_int(f) == 0]
    elif stops_preference == '1stop':
        flights = [f for f in flights if stops_int(f) is not None and stops_int(f) <= 1]
    # 'any' = no filter

    # 3. Departure time range filter
    after_t  = parse_hhmm(depart_after_str)
    before_t = parse_hhmm(depart_before_str)
    if after_t or before_t:
        def in_time_range(f):
            ft = parse_flight_time(f.departure)
            if ft is None:
                return True  # keep if unparseable
            if after_t  and ft < after_t:  return False
            if before_t and ft > before_t: return False
            return True
        flights = [f for f in flights if in_time_range(f)]

    # 4. Max duration filter
    if max_duration_hrs is not None:
        max_hrs = float(max_duration_hrs)
        flights = [f for f in flights if duration_to_hrs(f.duration) <= max_hrs]

    if not flights:
        logging.warning(f"All flights filtered out for {origins}->{destination}")
        return jsonify({"googlePrice": None, "priceLevel": None, "flightCount": 0, "flights": [], "topFlight": None})

    # ── Extract min price ──────────────────────────────────────────────────────
    prices = [p for p in (parse_price(f.price) for f in flights) if p is not None]
    if not prices:
        logging.warning(f"Flights found but no parseable prices for {origins}->{destination}")
        return jsonify({"googlePrice": None, "priceLevel": None, "flightCount": len(flights), "flights": [], "topFlight": None})

    min_price = min(prices)

    # Sort by price for consistent top-N list
    def flight_sort_key(f):
        p = parse_price(f.price)
        return p if p is not None else float('inf')
    flights_sorted = sorted(flights, key=flight_sort_key)

    # ── Build flight list (top 10) ─────────────────────────────────────────────
    flight_list = []
    for f in flights_sorted[:10]:
        flight_list.append({
            "airline":   f.name,
            "price":     f.price,
            "departure": f.departure,
            "arrival":   f.arrival,
            "duration":  f.duration,
            "stops":     stops_int(f),
            "is_best":   f.is_best
        })

    # topFlight = cheapest after filters
    top_flight = None
    if flights_sorted:
        f = flights_sorted[0]
        top_flight = {
            "airline":   f.name,
            "price":     f.price,
            "departure": f.departure,
            "arrival":   f.arrival,
            "duration":  f.duration,
            "stops":     stops_int(f)
        }

    # priceLevel from Google (use first result's context — may be None)
    price_level = None
    try:
        # get_flights returns result.current_price at the result level, not per flight
        # We don't have direct access here since we called per-origin; use None as default
        price_level = None
    except Exception:
        pass

    logging.info(
        f"{origins}->{destination} {departure_date}: "
        f"min={min_price}, {len(flights)} flights after filters, top={top_flight['airline'] if top_flight else 'n/a'}"
    )

    return jsonify({
        "googlePrice":  min_price,
        "priceLevel":   price_level,
        "flightCount":  len(flights),
        "flights":      flight_list,
        "topFlight":    top_flight
    })


@app.route("/fli-price", methods=["POST"])
def get_fli_price():
    if PRICE_SECRET and request.headers.get("X-Price-Secret") != PRICE_SECRET:
        return jsonify({"error": "Unauthorized"}), 401

    if not FLI_AVAILABLE:
        logging.warning("fli not installed; /fli-price returning null")
        return jsonify({"fliPrice": None, "priceLevel": None, "flightCount": 0, "flights": [], "topFlight": None})

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Missing JSON body"}), 400

    origin_raw        = body.get("origin")
    destination       = body.get("destination")
    departure_date    = body.get("departureDate")
    adults            = int(body.get("adults", 1))
    children          = int(body.get("children", 0))
    stops_preference  = body.get("stopsPreference", "any")
    depart_after_str  = body.get("departureTimeStart")
    depart_before_str = body.get("departureTimeEnd")
    max_duration_hrs  = body.get("maxDurationHours")

    if not all([origin_raw, destination, departure_date]):
        return jsonify({"error": "origin, destination, departureDate are required"}), 400

    if isinstance(origin_raw, list):
        origins = [o.strip().upper() for o in origin_raw if o.strip()]
    else:
        origins = [s.strip().upper() for s in str(origin_raw).split(',') if s.strip()]

    stops_map = {"direct": MaxStops.NON_STOP, "1stop": MaxStops.ONE_STOP_OR_FEWER, "any": MaxStops.ANY}
    max_stops = stops_map.get(stops_preference, MaxStops.ANY)

    total_passengers = adults + children
    passenger_info = FliPassengerInfo(adults=total_passengers)

    try:
        dest_airport = Airport[destination.strip().upper()]
    except KeyError:
        logging.warning(f"fli: unknown destination airport: {destination}")
        return jsonify({"fliPrice": None, "priceLevel": None, "flightCount": 0, "flights": [], "topFlight": None})

    all_flights = []
    search_client = SearchFlights()

    for orig in origins:
        try:
            origin_airport = Airport[orig]
        except KeyError:
            logging.warning(f"fli: unknown origin airport: {orig}, skipping")
            continue
        try:
            filters = FlightSearchFilters(
                origin=origin_airport,
                destination=dest_airport,
                departure_date=departure_date,
                passenger_info=passenger_info,
                seat_type=SeatType.ECONOMY,
                max_stops=max_stops,
            )
            results = search_client.search(filters)
            if results:
                all_flights.extend(results)
                logging.info(f"fli: {orig}->{destination}: {len(results)} flights")
        except Exception as e:
            logging.warning(f"fli: {orig}->{destination} error: {e}")

    if not all_flights:
        return jsonify({"fliPrice": None, "priceLevel": None, "flightCount": 0, "flights": [], "topFlight": None})

    def get_airline(f):
        return getattr(f, 'airline', None) or getattr(f, 'name', '') or ''

    # Drop no-price or no-airline rows
    flights = [
        f for f in all_flights
        if getattr(f, 'price', None) and str(getattr(f, 'price', '')).strip()
        and get_airline(f).strip()
    ]

    # Exclude Frontier/Spirit
    flights = [f for f in flights if not any(ex in get_airline(f).lower() for ex in EXCLUDED_AIRLINES)]

    # Departure time range
    after_t  = parse_hhmm(depart_after_str)
    before_t = parse_hhmm(depart_before_str)
    if after_t or before_t:
        def in_time_range(f):
            ft = parse_flight_time(f.departure)
            if ft is None:
                return True
            if after_t  and ft < after_t:  return False
            if before_t and ft > before_t: return False
            return True
        flights = [f for f in flights if in_time_range(f)]

    # Max duration
    if max_duration_hrs is not None:
        max_hrs = float(max_duration_hrs)
        flights = [f for f in flights if duration_to_hrs(f.duration) <= max_hrs]

    if not flights:
        return jsonify({"fliPrice": None, "priceLevel": None, "flightCount": 0, "flights": [], "topFlight": None})

    prices = [p for p in (parse_price(f.price) for f in flights) if p is not None]
    if not prices:
        return jsonify({"fliPrice": None, "priceLevel": None, "flightCount": len(flights), "flights": [], "topFlight": None})

    min_price = min(prices)

    def flight_sort_key(f):
        p = parse_price(f.price)
        return p if p is not None else float('inf')
    flights_sorted = sorted(flights, key=flight_sort_key)

    flight_list = []
    for f in flights_sorted[:10]:
        flight_list.append({
            "airline":   get_airline(f),
            "price":     f.price,
            "departure": f.departure,
            "arrival":   f.arrival,
            "duration":  f.duration,
            "stops":     stops_int(f),
            "is_best":   getattr(f, 'is_best', False),
        })

    top_flight = None
    if flights_sorted:
        f = flights_sorted[0]
        top_flight = {
            "airline":   get_airline(f),
            "price":     f.price,
            "departure": f.departure,
            "arrival":   f.arrival,
            "duration":  f.duration,
            "stops":     stops_int(f),
        }

    logging.info(f"fli: {origins}->{destination} {departure_date}: min={min_price}, {len(flights)} flights after filters")

    return jsonify({
        "fliPrice":    min_price,
        "priceLevel":  None,
        "flightCount": len(flights),
        "flights":     flight_list,
        "topFlight":   top_flight,
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
