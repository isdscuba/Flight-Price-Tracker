// Firebase Configuration
// Replace these values with your actual Firebase project configuration
// You can find these in Firebase Console > Project Settings > General > Your apps

const firebaseConfig = {
  apiKey: "AIzaSyDdmf5uOIkRJaGFir_gEXCwEMVpOPxd2pk",
  authDomain: "elev-flight-tracker.firebaseapp.com",
  projectId: "elev-flight-tracker",
  storageBucket: "elev-flight-tracker.firebasestorage.app",
  messagingSenderId: "48549327310",
  appId: "1:48549327310:web:0a4b818a9d034511933b9f"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const functions = firebase.functions();
const auth = firebase.auth();
