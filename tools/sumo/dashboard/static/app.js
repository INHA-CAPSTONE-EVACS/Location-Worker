const map = L.map("map", { zoomControl: false }).setView([37.388, 126.637], 14);
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);

const roads = new Map();
const vehicles = new Map();
const cells = new Map();
const cellToggle = document.querySelector("#cell-toggle");
const cellResolution = document.querySelector("#cell-resolution");
let sourceH3Resolution = null;

function densityColor(value) { if (value >= 20) return "#ff5d72"; if (value > 0) return "#ffc857"; return "#25d797"; }
function vehicleColor(type) { return type === "EMERGENCY" ? "#ff4862" : "#55a5ff"; }
function formatNumber(value) { return Number(value || 0).toLocaleString("ko-KR"); }
function cellColor(count) { if (count >= 5) return "#ff5d72"; if (count >= 2) return "#ffc857"; return "#25d797"; }

function configureCellResolution(sourceResolution) {
  if (sourceH3Resolution === sourceResolution) return;
  sourceH3Resolution = sourceResolution;
  cellResolution.replaceChildren();
  for (let resolution = 0; resolution <= sourceResolution; resolution += 1) {
    const option = new Option(`R${resolution}${resolution === sourceResolution ? " · 원본" : " · 합산"}`, resolution, resolution === sourceResolution, resolution === sourceResolution);
    cellResolution.add(option);
  }
  cellResolution.disabled = false;
  document.querySelector("#cell-help").textContent = `Worker 원본: H3 R${sourceResolution}. 낮은 R은 더 큰 육각형으로 합산합니다.`;
}

function removeCells() {
  for (const polygon of cells.values()) map.removeLayer(polygon);
  cells.clear();
}

async function loadCells() {
  if (!cellToggle.checked || sourceH3Resolution === null) return;
  const response = await fetch(`/api/cells?resolution=${cellResolution.value}`);
  if (!response.ok) throw new Error("H3 cell API failed");
  const payload = await response.json();
  removeCells();
  for (const cell of payload.cells) {
    const color = cellColor(cell.count);
    const polygon = L.polygon(cell.coordinates, { color, weight: 2, opacity: .85, fillColor: color, fillOpacity: .24, interactive: true }).addTo(map);
    polygon.bindTooltip(`H3 R${payload.resolution} · ${cell.count}대`, { sticky: true });
    cells.set(cell.id, polygon);
  }
}

function renderSnapshot(snapshot) {
  document.querySelector("#active-vehicles").textContent = formatNumber(snapshot.activeVehicles);
  document.querySelector("#generation").textContent = snapshot.generation;
  document.querySelector("#stream-length").textContent = formatNumber(snapshot.streamLength);
  document.querySelector("#h3-resolution").textContent = `R${snapshot.h3Resolution}`;
  document.querySelector("#updated-at").textContent = new Date(snapshot.generatedAt).toLocaleTimeString("ko-KR");
  configureCellResolution(snapshot.h3Resolution);
  const ready = snapshot.worker && snapshot.worker.ready;
  const pill = document.querySelector("#worker-pill");
  pill.textContent = ready ? "READY" : "연결 확인 필요";
  pill.className = `pill ${ready ? "ready" : "error"}`;
  document.querySelector("#worker-ready").textContent = ready ? "정상" : "확인 필요";
  document.querySelector("#connection").textContent = `SSE 연결됨 · ${snapshot.activeVehicles}대 흐름 표시 중`;

  for (const [edgeId, line] of roads) {
    const density = snapshot.density[edgeId];
    line.setStyle({ color: densityColor(density || 0), opacity: density > 0 ? .94 : .64, weight: density > 0 ? 6 : 4 });
  }
  const seen = new Set();
  for (const vehicle of snapshot.vehicles) {
    seen.add(vehicle.id);
    const target = L.latLng(vehicle.latitude, vehicle.longitude);
    const current = vehicles.get(vehicle.id);
    if (current) {
      current.from = current.marker.getLatLng(); current.target = target; current.startedAt = performance.now();
      current.marker.setStyle({ color: vehicleColor(vehicle.type), fillColor: vehicleColor(vehicle.type) });
    } else {
      const marker = L.circleMarker(target, { radius: vehicle.type === "EMERGENCY" ? 7 : 5, color: vehicleColor(vehicle.type), fillColor: vehicleColor(vehicle.type), fillOpacity: .95, weight: 2 }).addTo(map);
      marker.bindTooltip(vehicle.id, { direction: "top", offset: [0, -7], opacity: .85 });
      vehicles.set(vehicle.id, { marker, from: target, target, startedAt: performance.now() });
    }
  }
  for (const [id, state] of vehicles) if (!seen.has(id)) { map.removeLayer(state.marker); vehicles.delete(id); }
  loadCells().catch(() => { document.querySelector("#cell-help").textContent = "H3 셀 데이터를 불러오지 못했습니다."; });
}

function animateVehicles(now) {
  for (const state of vehicles.values()) {
    const progress = Math.min((now - state.startedAt) / 1150, 1);
    state.marker.setLatLng(L.latLng(state.from.lat + (state.target.lat - state.from.lat) * progress, state.from.lng + (state.target.lng - state.from.lng) * progress));
  }
  requestAnimationFrame(animateVehicles);
}

async function loadGeometry() {
  const response = await fetch("/dashboard-map.json");
  const data = await response.json();
  const group = [];
  for (const edge of data.edges) {
    const line = L.polyline(edge.coordinates, { color: "#25d797", opacity: .64, weight: 4, lineCap: "round" }).addTo(map);
    roads.set(edge.id, line); group.push(line);
  }
  if (group.length) map.fitBounds(L.featureGroup(group).getBounds(), { padding: [42, 42] });
}

function connect() {
  const events = new EventSource("/api/events");
  events.onmessage = ({ data }) => renderSnapshot(JSON.parse(data));
  events.onerror = () => { document.querySelector("#connection").textContent = "재연결 중…"; };
}

cellToggle.addEventListener("change", () => {
  if (cellToggle.checked) loadCells().catch(() => { document.querySelector("#cell-help").textContent = "H3 셀 데이터를 불러오지 못했습니다."; });
  else removeCells();
});
cellResolution.addEventListener("change", () => loadCells().catch(() => { document.querySelector("#cell-help").textContent = "H3 셀 데이터를 불러오지 못했습니다."; }));

loadGeometry().then(connect).catch(() => { document.querySelector("#connection").textContent = "지도 데이터를 불러오지 못했습니다"; });
requestAnimationFrame(animateVehicles);
