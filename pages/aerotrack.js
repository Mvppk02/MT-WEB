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
  peerMarkers: {},      // Map of peerId -> Leaflet marker
  poiMarkers: {},       // Map of POI name -> Leaflet marker
  pois: null,
  activePOI: null
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
  const defaultLat = 48.8566;
  const defaultLng = 2.3522;

  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([defaultLat, defaultLng], 14);

  const savedTheme = localStorage.getItem('aero-theme') || 'dark';
  setTheme(savedTheme);

  pathPolyline = L.polyline([], {
    color: 'var(--accent-primary)',
    weight: 4,
    opacity: 0.85,
    dashArray: '8, 8',
    lineJoin: 'round'
  }).addTo(map);

  loadPOIs();
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
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons();
  }
  if (tileLayer && map) {
    map.removeLayer(tileLayer);
  }
  const tileConfig = TILES[themeName];
  if (tileConfig && map) {
    tileLayer = L.tileLayer(tileConfig.url, {
      attribution: tileConfig.attribution,
      maxZoom: 20
    }).addTo(map);
  }
}

function restoreFromLocalStorage() {
  try {
    const savedPeerId = localStorage.getItem('active-peer-id');
    const savedPOI = localStorage.getItem('active-poi');
    if (savedPeerId) initPeer(savedPeerId);
    if (savedPOI) state.activePOI = savedPOI;
  } catch (_) {
    // ignore persistence recovery errors
  }
}

function persistToLocalStorage(key, value) {
  try {
    localStorage.setItem(`aerotrack-persist-${key}`, JSON.stringify(value));
  } catch (_) {
    // ignore persistence errors
  }
}

// Optional POI loader. Kept out of the default init path for now.
function loadPOIs() {
  if (typeof fetch === 'undefined') return;
  fetch('https://raw.githubusercontent.com/CarCVroom/mangeKartPunkt/main/data.json')
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
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
        state.poiMarkers[poi.name || `${poi.lat},${poi.lon}`] = marker;
      });
    })
    .catch(err => {
      console.warn('POIs not loaded:', err && err.message ? err.message : err);
    });
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
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
  const maxSpeed = 120;
  const speedPercentage = Math.min(speed / maxSpeed, 1);
  const circumference = 2 * Math.PI * 45;
  const dashOffset = circumference * (1 - speedPercentage);

  const gaugeFill = document.getElementById('speedGaugeFill');
  if (gaugeFill) {
    gaugeFill.style.strokeDashoffset = dashOffset;
  }

  document.getElementById('valSpeed').innerText = speed.toFixed(1);
  document.getElementById('valDistance').innerText = `${distance.toFixed(2)} km`;
  document.getElementById('valAltitude').innerText = altitude !== null ? `${altitude.toFixed(0)} m` : '-- m';
  document.getElementById('valHeading').innerText = heading !== null ? `${Math.round(heading)}°` : '--°';
  document.getElementById('valAccuracy').innerText = `${accuracy.toFixed(0)} m`;

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

  const speedKmh = speed ? (speed * 3.6) : 0;

  if (state.history.length > 0) {
    const lastPoint = state.history[state.history.length - 1];
    const segmentDistance = calculateDistance(lastPoint.lat, lastPoint.lng, lat, lng);

    if (segmentDistance > 0.002) {
      state.totalDistance += segmentDistance;
    }
  }

  state.currentPosition = { lat, lng, altitude, accuracy, heading, speed: speedKmh, timestamp };
  state.history.push({ lat, lng, alt: altitude, time: timestamp, speed: speedKmh });

  updateTelemetryUI(speedKmh, state.totalDistance, altitude, heading, accuracy);

  const latlng = [lat, lng];
  if (!userMarker) {
    userMarker = L.marker(latlng, { icon: userPinIcon }).addTo(map);
    map.setView(latlng, 17);
  } else {
    userMarker.setLatLng(latlng);
  }

  pathPolyline.addLatLng(latlng);

  if (state.isTracking) {
    map.panTo(latlng);
  }

  document.getElementById('btnExportGeoJSON').removeAttribute('disabled');
  document.getElementById('btnExportGPX').removeAttribute('disabled');

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

function toggleTracking() {
  const btn = document.getElementById('btnToggleTrack');
  const banner = document.getElementById('systemStatus');

  if (state.isTracking) {
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
        toggleTracking();
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

function startSimulation() {
  const btn = document.getElementById('btnSimulate');
  const banner = document.getElementById('systemStatus');

  if (state.isSimulating) {
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
    state.isSimulating = true;
    startTimer();

    btn.classList.add('active-btn');
    btn.innerHTML = '<i data-lucide="square" class="btn-icon"></i><span>Stop Sim</span>';

    banner.className = 'status-banner tracking';
    banner.innerHTML = '<i data-lucide="radio" class="status-icon"></i><span class="status-text">SIMULATING MOVEMENTS</span>';

    document.getElementById('btnToggleTrack').setAttribute('disabled', 'true');

    const center = map.getCenter();
    const startLat = center.lat;
    const startLng = center.lng;

    state.simIndex = 0;

    state.simInterval = setInterval(() => {
      state.simIndex++;
      const t = state.simIndex * 0.04;
      const offsetLat = Math.sin(t) * 0.005;
      const offsetLng = Math.sin(t * 2) * 0.008;

      const currentLat = startLat + offsetLat;
      const currentLng = startLng + offsetLng;

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
          speed: simulatedSpeed / 3.6,
          accuracy: simulatedAccuracy
        },
        timestamp: Date.now()
      };

      handlePositionUpdate(positionObj);
    }, 1000);
  }
  lucide.createIcons();
}

function initPeerJS() {
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

    showConnectedPeerInUI(peerId);

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
  const { lat, lng, altitude, speed } = telemetry;
  const latlng = [lat, lng];

  let marker = state.peerMarkers[peerId];
  if (!marker) {
    marker = L.marker(latlng, { icon: peerPinIcon }).addTo(map);
    state.peerMarkers[peerId] = marker;
  } else {
    marker.setLatLng(latlng);
  }

  const formattedSpeed = speed ? `${speed.toFixed(1)} km/h` : 'Stopped';
  const formattedAlt = altitude ? `${Math.round(altitude)}m` : '--';
  marker.bindPopup(`
    <div style="font-family: var(--font-sans); color: #080a10; font-size: 12px; font-weight: 500;">
      <h4 style="margin-bottom: 4px; font-weight: 700; color: #4f46e5;">Frequency Relay: ${peerId.substring(0, 8)}</h4>
      <p><b>Speed:</b> ${formattedSpeed}</p>
      <p><b>Altitude:</b> ${formattedAlt}</p>
    </div>
  `);
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
    <button class="btn-peer-disconnect" onclick="disconnectFromPeer('${peerId.replace(/'/g, "\\'")}')" title="Disconnect Peer">
      <i data-lucide="x-circle"></i>
    </button>
  `;

  container.appendChild(peerItem);
  lucide.createIcons();
}

function removeConnectedPeer(peerId) {
  const marker = state.peerMarkers[peerId];
  if (marker) {
    map.removeLayer(marker);
    delete state.peerMarkers[peerId];
  }

  if (state.activeConnections[peerId]) {
    state.activeConnections[peerId].close();
    delete state.activeConnections[peerId];
  }

  const item = document.getElementById(`ui-peer-${peerId}`);
  if (item) {
    item.remove();
  }

  if (Object.keys(state.activeConnections).length === 0) {
    document.getElementById('activePeersPanel').classList.add('hidden');
  }
}

window.disconnectFromPeer = function (peerId) {
  removeConnectedPeer(peerId);
};

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

function bindEvents() {
  document.getElementById('btnToggleTrack').addEventListener('click', toggleTracking);
  document.getElementById('btnSimulate').addEventListener('click', startSimulation);

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

  document.getElementById('btnExportGeoJSON').addEventListener('click', exportGeoJSON);
  document.getElementById('btnExportGPX').addEventListener('click', exportGPX);
  document.getElementById('btnClearData').addEventListener('click', clearTrackHistory);

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
      prompt('Copy your sharing link manually:', shareUrl);
    });
  });

  document.getElementById('btnConnectPeer').addEventListener('click', () => {
    const inputVal = document.getElementById('inputPeerId').value;
    if (inputVal) {
      connectToPeer(inputVal);
      document.getElementById('inputPeerId').value = '';
    }
  });

  const mobileToggle = document.getElementById('mobilePanelToggle');
  const sidebar = document.getElementById('dashboardPanel');
  const chevron = document.getElementById('toggleChevron');

  mobileToggle.addEventListener('click', () => {
    sidebar.classList.toggle('expanded');
    mobileToggle.classList.toggle('active');
    chevron.setAttribute('data-lucide', sidebar.classList.contains('expanded') ? 'chevron-down' : 'chevron-up');
    lucide.createIcons();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  bindEvents();
  lucide.createIcons();
  initPeerJS();
});
