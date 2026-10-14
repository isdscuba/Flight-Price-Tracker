"""Second Google Flights source using fast-flights 3.x (different request/parse path than
the 2.2-based service in ../fetcher). Same request body as /price; returns the cheapest
matching itinerary after the same stop/time/duration/airline filters."""
import os
import hmac
import time
import logging
from datetime import datetime, timedelta
from flask import Flask, request, jsonify
from fast_flights import FlightQuery, Passengers, create_query, get_flights

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

PRICE_SECRET = os.environ.get("PRICE_SECRET", "")
EXCLUDED_AIRLINES = {"frontier", "spirit"}
EMPTY = {"googlePrice": None, "flightCount": 0, "topFlight": None}


def parse_hhmm(s):
    try:
        return datetime.strptime(s, "%H:%M").time() if s else None
    except ValueError:
        return None


def seg_dt(sd):
    """SimpleDatetime -> naive datetime (local to that airport)."""
    (y, mo, d), (h, mi) = sd.date, sd.time
    return datetime(y, mo, d, h, mi)


def total_minutes(segs):
    """Sum of leg durations plus layovers (layover = next dep - prev arr, same airport/timezone)."""
    total = sum(s.duration for s in segs)
    for a, b in zip(segs, segs[1:]):
        total += int((seg_dt(b.departure) - seg_dt(a.arrival)).total_seconds() // 60)
    return total


def fmt_dt(sd):
    dt = seg_dt(sd)
    return dt.strftime("%-I:%M %p on %a, %b %-d")


def fmt_dur(mins):
    h, m = divmod(int(mins), 60)
    return f"{h} hr {m} min" if m else f"{h} hr"


@app.route("/price", methods=["POST"])
def price():
    if PRICE_SECRET and not hmac.compare_digest(request.headers.get("X-Price-Secret", ""), PRICE_SECRET):
        return jsonify({"error": "Unauthorized"}), 401
    b = request.get_json(silent=True) or {}
    origin_raw, dest, dep = b.get("origin"), b.get("destination"), b.get("departureDate")
    if not (origin_raw and dest and dep):
        return jsonify({"error": "origin, destination, departureDate are required"}), 400
    ret = b.get("returnDate")
    origins = origin_raw if isinstance(origin_raw, list) else str(origin_raw).split(",")
    origins = [o.strip().upper() for o in origins if o.strip()][:5]
    pax = int(b.get("adults", 1)) + int(b.get("children", 0))
    stops_pref = b.get("stopsPreference", "any")
    max_stops = {"direct": 0, "1stop": 1}.get(stops_pref)
    after, before = parse_hhmm(b.get("departureTimeStart")), parse_hhmm(b.get("departureTimeEnd"))
    max_hrs = float(b["maxDurationHours"]) if b.get("maxDurationHours") else None

    best = None
    count = 0
    for i, orig in enumerate(origins):
        if i:
            time.sleep(2)
        try:
            legs = [FlightQuery(date=dep, from_airport=orig, to_airport=dest)]
            if ret:
                legs.append(FlightQuery(date=ret, from_airport=dest, to_airport=orig))
            q = create_query(flights=legs, trip="round-trip" if ret else "one-way",
                             passengers=Passengers(adults=pax), seat="economy", max_stops=max_stops)
            results = get_flights(q)
        except Exception as e:
            logging.warning(f"v3 no results for {orig}->{dest}: {e}")
            continue
        for r in results:
            segs = r.flights
            if not segs or not r.price:
                continue
            if any(ex in a.lower() for a in r.airlines for ex in EXCLUDED_AIRLINES):
                continue
            if max_stops is not None and len(segs) - 1 > max_stops:
                continue
            t = seg_dt(segs[0].departure).time()
            if (after and t < after) or (before and t > before):
                continue
            mins = total_minutes(segs)
            if max_hrs is not None and mins / 60 > max_hrs:
                continue
            count += 1
            if best is None or r.price < best[0].price:
                best = (r, mins)

    if best is None:
        logging.warning(f"v3: nothing matched filters for {origins}->{dest} {dep}")
        return jsonify(EMPTY)
    r, mins = best
    segs = r.flights
    top = {
        "airline": ", ".join(r.airlines), "price": f"${r.price}",
        "departure": fmt_dt(segs[0].departure), "arrival": fmt_dt(segs[-1].arrival),
        "duration": fmt_dur(mins), "stops": len(segs) - 1, "origin": segs[0].from_airport.code,
    }
    logging.info(f"v3 {origins}->{dest} {dep}: min={r.price}, {count} matching")
    return jsonify({"googlePrice": float(r.price), "flightCount": count, "topFlight": top})


@app.route("/health")
def health():
    return jsonify({"status": "ok"})
