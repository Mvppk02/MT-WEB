/**
 * AEROTRACK - REAL-TIME TELEMETRY ENGINE & GEOLOCATION MATRIX
 * PeerJS (P2P WebRTC) + Leaflet JS + Geolocation API
 */

// --- APPLICATION STATE ---
const state = {
  isTracking: false,
  isSimulating: false,
  theme: 'dark', // 'dark' | 'light'

  // GPS & Telemetry Data
  currentPosition: null, // { lat, lng, altitude, accuracy, heading, speed, timestamp }
  history: [],          // Array of coordinate points logged over time: [ {lat, lng, alt, time, speed} ]
  startTime: null,
  totalDistance: 0,     // In kilometers
  durationTimer: null,
  elapsedSeconds: 0,
  watchId: null,        // Geolocation watcher ID

  // Simulation parameters
  simIndex: 0,
  simInterval: null,

  // PeerJS Connections
  myPeerId: null,
  peerInstance: null,
  activeConnections: {}, // Map of peerId -> connection
  peerMarkers: {}, // Map of peerId -> Leaflet marker
  poiMarkers: {} // Map of POI name -> Leaflet marker
};

// --- LEAFLET MAP MODULE ---
let map = null;
let userMarker = null;
let pathPolyline = null;
let tileLayer = null;

// Tile Providers
const TILES = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }
};

// SVG Icon Definitions for Markers
const userPinIcon = L.divIcon({
  className: 'custom-pin',
  html: '<div class="pin-ring"><div class="pin-core"></div></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

const peerPinIcon = L.divIcon({
  className: 'custom-pin',
  html: '<div class="pin-ring pin-ring-peer"><div class="pin-core pin-core-peer"></div></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

function initMap() {
  console.log('Initializing map...');
  // Default centered coordinates (Paris, France - placeholder until tracking kicks in)
  const defaultLat = 48.8566;
  const defaultLng = 2.3522;

  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([defaultLat, defaultLng], 14);

  // Set initial map theme
  const savedTheme = localStorage.getItem('aero-theme') || 'dark';
  setTheme(savedTheme);

  // Polyline for tracking trace
  pathPolyline = L.polyline([], {
    color: 'var(--accent-primary)',
    weight: 4,
    opacity: 0.85,
    dashArray: '8, 8',
    lineJoin: 'round'
  }).addTo(map);

  loadPOIs();

  // Auto‑start tracking if a position is already available
  if (navigator.geolocation) {
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          // Position obtained, start tracking (watchPosition will handle updates)
          toggleTracking();
        },
        (err) => {
          console.warn('Auto‑start tracking unavailable:', err);
        }
      );
    } catch (e) {
      console.error('Error during auto‑start tracking:', e);
    }
  }
}

function loadPOIs() {
  fetch('../CarCVroom_mangeKartPunkt/data.json')
    .then(response => response.json())
    .then(data => {
      state.pois = data;
      data.forEach(poi => {
        const marker = L.circleMarker([poi.lat, poi.lon], {
          radius: 10,
          color: 'red',
          weight: 2,
          fillColor: 'red',
          fillOpacity: 0.8
        }).addTo(map);
        state.poiMarkers[poi.name] = marker;
      });
    })
    .catch(err => console.error('Failed to load POIs:', err));
}

function setTheme(themeName) {
  state.theme = themeName;
  localStorage.setItem('aero-theme', themeName);

  if (themeName === 'light') {
    document.body.classList.remove('dark-theme');
    document.body.classList.add('light-theme');
    document.getElementById('themeIcon').setAttribute('data-lucide', 'moon');
  } else {
    document.body.classList.remove('light-theme');
    document.body.classList.add('dark-theme');
    document.getElementById('themeIcon').setAttribute('data-lucide', 'sun');
  }
  lucide.createIcons(); // Refresh Lucide elements

  // Re-inject tiles
  if (tileLayer) {
    map.removeLayer(tileLayer);
  }

  tileLayer = L.tileLayer(TILES[themeName].url, {
    attribution: TILES[themeName].attribution,
    maxZoom: 20
  }).addTo(map);
}

// --- TELEMETRY & DATA UPDATE CONTROLLER ---

// Spherical Law of Cosines to find distance between two points in km
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function updateTelemetryUI(speed, distance, altitude, heading, accuracy) {
  // Speed gauge animation
  const maxSpeed = 120; // km/h limit on dashboard gauge visual
  const speedPercentage = Math.min(speed / maxSpeed, 1);
  const circumference = 2 * Math.PI * 45; // 282.74
  const dashOffset = circumference * (1 - speedPercentage);

  const gaugeFill = document.getElementById('speedGaugeFill');
  if (gaugeFill) {
    gaugeFill.style.strokeDashoffset = dashOffset;
  }

  // Value updates
  document.getElementById('valSpeed').innerText = speed.toFixed(1);
  document.getElementById('valDistance').innerText = `${distance.toFixed(2)} km`;
  document.getElementById('valAltitude').innerText = altitude !== null ? `${altitude.toFixed(0)} m` : '-- m';
  document.getElementById('valHeading').innerText = heading !== null ? `${Math.round(heading)}°` : '--°';
  document.getElementById('valAccuracy').innerText = `${accuracy.toFixed(0)} m`;

  // Average speed calculation
  if (state.elapsedSeconds > 0) {
    const avgSpeed = (state.totalDistance / (state.elapsedSeconds / 3600));
    document.getElementById('valAvgSpeed').innerText = `${avgSpeed.toFixed(1)} km/h`;
  }
}

function handlePositionUpdate(position) {
  const { latitude, longitude, altitude, heading, speed, accuracy } = position.coords;
  const timestamp = position.timestamp;

  const lat = latitude;
  const lng = longitude;

  // Geolocation speed is in m/s, convert to km/h. Default to 0 if null.
  const speedKmh = speed ? (speed * 3.6) : 0;

  // Calculate distance traveled if history is populated
  if (state.history.length > 0) {
    const lastPoint = state.history[state.history.length - 1];
    const segmentDistance = calculateDistance(lastPoint.lat, lastPoint.lng, lat, lng);

    // Ignore updates that are too tiny/noisy to prevent odometer jitter
    if (segmentDistance > 0.002) {
      state.totalDistance += segmentDistance;
    }
  }

  // Update State
  state.currentPosition = { lat, lng, altitude, accuracy, heading, speed: speedKmh, timestamp };
  state.history.push({ lat, lng, alt: altitude, time: timestamp, speed: speedKmh });

  // Update UI Telemetry
  updateTelemetryUI(speedKmh, state.totalDistance, altitude, heading, accuracy);

  // Update Map Position
  const latlng = [lat, lng];
  if (!userMarker) {
    userMarker = L.marker(latlng, { icon: userPinIcon }).addTo(map);
    map.setView(latlng, 17);
  } else {
    userMarker.setLatLng(latlng);
  }

  // Add point to polyline path
  pathPolyline.addLatLng(latlng);

  // Auto center map if tracking is active
  if (state.isTracking) {
    map.panTo(latlng);
  }

  // Update POI marker colors based on proximity (within 50m)
  const proximityThresholdKm = 0.05; // 50 meters
  Object.values(state.poiMarkers).forEach(marker => {
    const markerPos = marker.getLatLng();
    const dist = calculateDistance(lat, lng, markerPos.lat, markerPos.lng);
    if (dist <= proximityThresholdKm) {
      marker.setStyle({ color: 'green', fillColor: 'green' });
    } else {
      marker.setStyle({ color: 'red', fillColor: 'red' });
    }
  });

  // Enable download export buttons since data exists
  document.getElementById('btnExportGeoJSON').removeAttribute('disabled');
  document.getElementById('btnExportGPX').removeAttribute('disabled');

  // Push updates to active WebRTC peers
  broadcastToPeers({
    type: 'LOCATION_UPDATE',
    payload: { lat, lng, altitude, speed: speedKmh, heading, accuracy }
  });
}

function startTimer() {
  state.startTime = new Date();
  state.durationTimer = setInterval(() => {
    state.elapsedSeconds++;

    const hrs = String(Math.floor(state.elapsedSeconds / 3600)).padStart(2, '0');
    const mins = String(Math.floor((state.elapsedSeconds % 3600) / 60)).padStart(2, '0');
    const secs = String(state.elapsedSeconds % 60).padStart(2, '0');

    document.getElementById('valDuration').innerText = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  if (state.durationTimer) {
    clearInterval(state.durationTimer);
    state.durationTimer = null;
  }
}

// --- GPS TRACKING TOGGLE MODULE ---
function toggleTracking() {
  const btn = document.getElementById('btnToggleTrack');
  const banner = document.getElementById('systemStatus');

  if (state.isTracking) {
    // STOP TRACKING
    state.isTracking = false;
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    stopTimer();

    btn.classList.remove('active-btn');
    btn.innerHTML = '<i data-lucide="play" class="btn-icon"></i><span>Start Tracking</span>';

    banner.className = 'status-banner online';
    banner.innerHTML = '<i data-lucide="shield-check" class="status-icon"></i><span class="status-text">SYSTEM STANDBY</span>';

    document.getElementById('btnSimulate').removeAttribute('disabled');
  } else {
    // START TRACKING
    if (!navigator.geolocation) {
      alert('Your browser does not support GPS Geolocation.');
      return;
    }

    state.isTracking = true;
    startTimer();

    btn.classList.add('active-btn');
    btn.innerHTML = '<i data-lucide="square" class="btn-icon"></i><span>Stop Tracking</span>';

    banner.className = 'status-banner tracking';
    banner.innerHTML = '<i data-lucide="radio" class="status-icon"></i><span class="status-text">TRANSMITTING TELEMETRY</span>';

    document.getElementById('btnSimulate').setAttribute('disabled', 'true');

    state.watchId = navigator.geolocation.watchPosition(
      handlePositionUpdate,
      (err) => {
        console.error('GPS Watch error:', err);
        alert(`GPS Position error: ${err.message}. Make sure location access is allowed.`);
        toggleTracking(); // Shut down gracefully
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }
  lucide.createIcons();
}

// --- GEOLOCATION SIMULATION MODULE (FOR TESTING ON DESKTOP) ---
// Generates a dynamic racetrack path centered around the map's current center coordinates
function startSimulation() {
  const btn = document.getElementById('btnSimulate');
  const banner = document.getElementById('systemStatus');

  if (state.isSimulating) {
    // STOP SIMULATION
    state.isSimulating = false;
    clearInterval(state.simInterval);
    state.simInterval = null;
    stopTimer();

    btn.classList.remove('active-btn');
    btn.innerHTML = '<i data-lucide="navigation-2" class="btn-icon"></i><span>Simulate Route</span>';

    banner.className = 'status-banner online';
    banner.innerHTML = '<i data-lucide="shield-check" class="status-icon"></i><span class="status-text">SYSTEM STANDBY</span>';

    document.getElementById('btnToggleTrack').removeAttribute('disabled');
  } else {
    // START SIMULATION
    state.isSimulating = true;
    startTimer();

    btn.classList.add('active-btn');
    btn.innerHTML = '<i data-lucide="square" class="btn-icon"></i><span>Stop Sim</span>';

    banner.className = 'status-banner tracking';
    banner.innerHTML = '<i data-lucide="radio" class="status-icon"></i><span class="status-text">SIMULATING MOVEMENTS</span>';

    document.getElementById('btnToggleTrack').setAttribute('disabled', 'true');

    // Base point is map center
    const center = map.getCenter();
    const startLat = center.lat;
    const startLng = center.lng;

    state.simIndex = 0;

    // Racetrack coordinate calculation formula (lissajous loop style)
    state.simInterval = setInterval(() => {
      state.simIndex++;
      const t = state.simIndex * 0.04;
      // Scale offsets to make movement look fast but detailed
      const offsetLat = Math.sin(t) * 0.005;
      const offsetLng = Math.sin(t * 2) * 0.008;

      const currentLat = startLat + offsetLat;
      const currentLng = startLng + offsetLng;

      // Simulated telemetry
      // Speed swings dynamically to show dashboard activity
      const simulatedSpeed = 30 + Math.sin(t * 1.5) * 20;
      const simulatedAltitude = 150 + Math.cos(t) * 15;
      const simulatedHeading = (t * (180 / Math.PI)) % 360;
      const simulatedAccuracy = 5 + Math.sin(t) * 2;

      const positionObj = {
        coords: {
          latitude: currentLat,
          longitude: currentLng,
          altitude: simulatedAltitude,
          heading: simulatedHeading,
          speed: simulatedSpeed / 3.6, // convert back to m/s so callback processes it right
          accuracy: simulatedAccuracy
        },
        timestamp: Date.now()
      };

      handlePositionUpdate(positionObj);
    }, 1000);
  }
  lucide.createIcons();
}

// --- PeerJS P2P COMMUNICATION MODULE ---
function initPeerJS() {
  // Initialize PeerJS broker server
  state.peerInstance = new Peer(null, {
    debug: 2
  });

  state.peerInstance.on('open', (id) => {
    state.myPeerId = id;
    document.getElementById('peerIdDisplay').innerText = id;

    const banner = document.getElementById('systemStatus');
    banner.className = 'status-banner online';
    banner.innerHTML = '<i data-lucide="shield-check" class="status-icon"></i><span class="status-text">SYSTEM ONLINE</span>';
    lucide.createIcons();

    // Check query params to auto-join a shared link session
    const urlParams = new URLSearchParams(window.location.search);
    const joinRoomId = urlParams.get('room');
    if (joinRoomId) {
      connectToPeer(joinRoomId);
    }
  });

  state.peerInstance.on('connection', (conn) => {
    setupConnectionListeners(conn);
  });

  state.peerInstance.on('error', (err) => {
    console.error('PeerJS instance error:', err);
    if (err.type === 'peer-not-found') {
      alert('The requested frequency ID could not be found.');
    } else {
      alert(`P2P Network Error: ${err.type}`);
    }
  });
}

function connectToPeer(targetId) {
  if (!state.peerInstance || !state.myPeerId) {
    alert('PeerJS client is not initialized yet. Try again in a moment.');
    return;
  }

  const peerId = targetId.trim();
  if (!peerId) return;

  if (peerId === state.myPeerId) {
    alert("You cannot connect to your own frequency ID.");
    return;
  }

  if (state.activeConnections[peerId]) {
    alert('Already connected to this frequency.');
    return;
  }

  const conn = state.peerInstance.connect(peerId);
  setupConnectionListeners(conn);
}

function setupConnectionListeners(conn) {
  const peerId = conn.peer;

  conn.on('open', () => {
    state.activeConnections[peerId] = conn;

    // Add UI representation for connection
    showConnectedPeerInUI(peerId);

    // If currently tracking or simulating, immediately send latest coordinate
    if (state.currentPosition) {
      conn.send({
        type: 'LOCATION_UPDATE',
        payload: {
          lat: state.currentPosition.lat,
          lng: state.currentPosition.lng,
          altitude: state.currentPosition.altitude,
          speed: state.currentPosition.speed,
          heading: state.currentPosition.heading,
          accuracy: state.currentPosition.accuracy
        }
      });
    }
  });

  conn.on('data', (data) => {
    if (data.type === 'LOCATION_UPDATE') {
      updatePeerMarker(peerId, data.payload);
    }
  });

  conn.on('close', () => {
    removeConnectedPeer(peerId);
  });

  conn.on('error', (err) => {
    console.error('Connection error for peer:', peerId, err);
    removeConnectedPeer(peerId);
  });
}

function broadcastToPeers(msg) {
  Object.values(state.activeConnections).forEach((conn) => {
    if (conn.open) {
      conn.send(msg);
    }
  });
}

function updatePeerMarker(peerId, telemetry) {
  const { lat, lng, altitude, speed, heading } = telemetry;
  const latlng = [lat, lng];

  let marker = state.peerMarkers[peerId];
  if (!marker) {
    // Create new peer marker with custom SVG icon
    marker = L.marker(latlng, { icon: peerPinIcon }).addTo(map);
    state.peerMarkers[peerId] = marker;
  } else {
    marker.setLatLng(latlng);
  }

  // Bind/Update Popup details
  const formattedSpeed = speed ? `${speed.toFixed(1)} km/h` : 'Stopped';
  const formattedAlt = altitude ? `${Math.round(altitude)}m` : '--';
  marker.bindPopup(`
    <div style="font-family: var(--font-sans); color: #080a10; font-size: 12px; font-weight: 500;">
      <h4 style="margin-bottom: 4px; font-weight: 700; color: #4f46e5;">Frequency Relay: ${peerId.substring(0, 8)}</h4>
      <p><b>Speed:</b> ${formattedSpeed}</p>
      <p><b>Altitude:</b> ${formattedAlt}</p>
    </div>
  `);

  // Animate map fit bounds if necessary, or let the user decide.
  // We'll keep focus on current tracker unless user pans manually.
}

function showConnectedPeerInUI(peerId) {
  const panel = document.getElementById('activePeersPanel');
  const container = document.getElementById('peersListContainer');

  panel.classList.remove('hidden');

  const peerItem = document.createElement('div');
  peerItem.className = 'peer-item';
  peerItem.id = `ui-peer-${peerId}`;
  peerItem.innerHTML = `
    <div class="peer-info">
      <div class="peer-status-dot"></div>
      <span class="peer-name" title="${peerId}">Relay: ${peerId.substring(0, 8)}...</span>
    </div>
    <button class="btn-peer-disconnect" onclick="disconnectFromPeer('${peerId}')" title="Disconnect Peer">
      <i data-lucide="x-circle"></i>
    </button>
  `;

  container.appendChild(peerItem);
  lucide.createIcons();
}

function removeConnectedPeer(peerId) {
  // Remove marker from map
  const marker = state.peerMarkers[peerId];
  if (marker) {
    map.removeLayer(marker);
    delete state.peerMarkers[peerId];
  }

  // Remove connection
  if (state.activeConnections[peerId]) {
    state.activeConnections[peerId].close();
    delete state.activeConnections[peerId];
  }

  // Remove UI element
  const item = document.getElementById(`ui-peer-${peerId}`);
  if (item) {
    item.remove();
  }

  // Hide list wrapper if empty
  if (Object.keys(state.activeConnections).length === 0) {
    document.getElementById('activePeersPanel').classList.add('hidden');
  }
}

// Window global helper for the HTML disconnect button click
window.disconnectFromPeer = function (peerId) {
  removeConnectedPeer(peerId);
};


// --- TELEMETRY EXPORT SERVICES (GeoJSON & GPX) ---
function exportGeoJSON() {
  if (state.history.length === 0) return;

  const coordinates = state.history.map(pt => [pt.lng, pt.lat, pt.alt || 0]);
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'AeroTrack Telemetry Run',
          startTime: state.startTime,
          totalDistanceKm: state.totalDistance,
          elapsedSeconds: state.elapsedSeconds
        },
        geometry: {
          type: 'LineString',
          coordinates: coordinates
        }
      }
    ]
  };

  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(geojson, null, 2));
  triggerDownload(dataStr, `aerotrack_${Date.now()}.geojson`);
}

function exportGPX() {
  if (state.history.length === 0) return;

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AeroTrack" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>AeroTrack Route</name>
    <time>${state.startTime ? new Date(state.startTime).toISOString() : new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>Telemetry Run</name>
    <trkseg>`;

  state.history.forEach((pt) => {
    const timeIso = new Date(pt.time).toISOString();
    gpx += `
      <trkpt lat="${pt.lat}" lon="${pt.lng}">
        <ele>${pt.alt || 0}</ele>
        <time>${timeIso}</time>
      </trkpt>`;
  });

  gpx += `
    </trkseg>
  </trk>
</gpx>`;

  const dataStr = "data:text/xml;charset=utf-8," + encodeURIComponent(gpx);
  triggerDownload(dataStr, `aerotrack_${Date.now()}.gpx`);
}

function triggerDownload(url, filename) {
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", url);
  downloadAnchor.setAttribute("download", filename);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

function clearTrackHistory() {
  if (confirm("Are you sure you want to clear your route tracking history?")) {
    state.history = [];
    state.totalDistance = 0;
    state.elapsedSeconds = 0;
    state.currentPosition = null;

    if (userMarker) {
      map.removeLayer(userMarker);
      userMarker = null;
    }
    if (pathPolyline) {
      pathPolyline.setLatLngs([]);
    }

    updateTelemetryUI(0, 0, null, null, 0);
    document.getElementById('valDuration').innerText = '00:00:00';
    document.getElementById('valAvgSpeed').innerText = '0.0 km/h';

    document.getElementById('btnExportGeoJSON').setAttribute('disabled', 'true');
    document.getElementById('btnExportGPX').setAttribute('disabled', 'true');
  }
}

// --- DOM EVENT LISTENERS ---
function bindEvents() {
  // Tracking & Sim Toggles
  document.getElementById('btnToggleTrack').addEventListener('click', toggleTracking);
  document.getElementById('btnSimulate').addEventListener('click', startSimulation);

  // Map settings controls
  document.getElementById('btnThemeToggle').addEventListener('click', () => {
    const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
  });

  document.getElementById('btnCenterMap').addEventListener('click', () => {
    if (state.currentPosition) {
      map.setView([state.currentPosition.lat, state.currentPosition.lng], 17);
    } else {
      alert("No active GPS lock to center map on.");
    }
  });

  // Export buttons
  document.getElementById('btnExportGeoJSON').addEventListener('click', exportGeoJSON);
  document.getElementById('btnExportGPX').addEventListener('click', exportGPX);
  document.getElementById('btnClearData').addEventListener('click', clearTrackHistory);

  // Share session copy
  document.getElementById('btnShareSession').addEventListener('click', () => {
    if (!state.myPeerId) {
      alert('Peer session not established yet.');
      return;
    }
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${state.myPeerId}`;

    navigator.clipboard.writeText(shareUrl).then(() => {
      alert('Shareable map telemetry URL copied to clipboard!');
    }).catch(err => {
      console.error('Copy share link error:', err);
      // Fallback
      prompt('Copy your sharing link manually:', shareUrl);
    });
  });

  // Connect manually
  document.getElementById('btnConnectPeer').addEventListener('click', () => {
    const inputVal = document.getElementById('inputPeerId').value;
    if (inputVal) {
      connectToPeer(inputVal);
      document.getElementById('inputPeerId').value = '';
    }
  });

  // Mobile navigation bottom sheet drawer
  const mobileToggle = document.getElementById('mobilePanelToggle');
  const sidebar = document.getElementById('dashboardPanel');
  const chevron = document.getElementById('toggleChevron');

  mobileToggle.addEventListener('click', () => {
    sidebar.classList.toggle('expanded');
    mobileToggle.classList.toggle('active');
    if (sidebar.classList.contains('expanded')) {
      chevron.setAttribute('data-lucide', 'chevron-down');
    } else {
      chevron.setAttribute('data-lucide', 'chevron-up');
    }
    lucide.createIcons();
  });
}

// --- INITIALIZE APPLICATION ---
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  bindEvents();
  lucide.createIcons();
  initPeerJS();
});
