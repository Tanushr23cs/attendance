const API_BASE = "http://127.0.0.1:5000";

let video, canvas, output, scanState;
let attendanceInterval = null;
let dashboardInterval = null;
let currentProfileData = null;
let currentProfileName = "";
let adminSessionPassword = "";
let scannedCount = 0;
let sessionStartTime = null;
let sessionTimerInterval = null;
let sessionMarkedCount = 0;
let sessionUniqueSet = new Set();
let periodTimings = [];
let currentPeriod = null;
let detectedFaces = {}; // Track unique faces in current view
let attendanceSyncInterval = null;
let attendanceSyncInFlight = false;
let lastAttendanceSignature = "";
let latestTodayAttendance = null;
const ATTENDANCE_SYNC_MS = 4000;

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const showMessage = (msg, isError = false) => {
  const box = output || $("output");
  const text = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
  if (box) box.innerHTML = `<p style="color:${isError ? "#f43f5e" : "#a5f3fc"}">${text}</p>`;
  if (isError) console.error(text);
};
const setScanState = (active) => {
  if (!scanState) return;
  scanState.textContent = active ? "Scanning" : "Ready";
  scanState.classList.toggle("live", active);
  const start = $("startBtn"), stop = $("stopBtn"), status = $("sessionStatus");
  if (start && stop) {
    start.style.display = active ? "none" : "inline-flex";
    stop.style.display = active ? "inline-flex" : "none";
  }
  if (status) status.textContent = active ? "Active" : "Idle";
};

/* ---------- Real-time attendance tracking ---------- */
const buildAttendanceSignature = (data = {}) => data.signature || `${data.date || ""}:${data.count || data.today_present || 0}:${data.last_updated || ""}`;

const fetchTodayAttendanceData = async () => {
  const res = await fetch(`${API_BASE}/get_today_attendance`);
  if (!res.ok) throw new Error("Failed to fetch today's attendance");
  return res.json();
};

const applyTodaySummary = (data = {}) => {
  const summary = data.summary || {};
  const count = data.count ?? data.today_present ?? summary.today_present ?? 0;
  const totalStudents = summary.total_students ?? $("statTotalStudents")?.textContent ?? $("totalStudents")?.textContent ?? 0;
  const classDays = summary.class_days ?? $("statClassDays")?.textContent ?? $("classDays")?.textContent ?? 0;
  const avgAttendance = `${summary.avg_attendance ?? 0}%`;

  [["todayPresent", count],
  ["statTodayPresent", count],
  ["todayAttendance", count],
  ["statTotalStudents", totalStudents],
  ["totalStudents", totalStudents],
  ["statClassDays", classDays],
  ["classDays", classDays],
  ["statAvgAttendance", avgAttendance],
  ["avgAttendance", avgAttendance]]
    .forEach(([id, value]) => { if ($(id)) $(id).textContent = value; });
};

const renderTodayAttendanceRows = (data = {}) => {
  const tbody = $("todayAttendanceTable");
  if (!tbody) return;

  const records = Array.isArray(data.records) ? data.records : [];
  if (!records.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">No records yet</td></tr>`;
    return;
  }

  tbody.innerHTML = records.map((record) => `
    <tr>
      <td>${record.name}</td>
      <td>${record.time || "--:--:--"}</td>
      <td><span class="pill live">${record.status || "Present"}</span></td>
    </tr>
  `).join("");
};

const renderPeriodWiseAttendanceRows = (periods = {}) => {
  const tbody = $("periodAttendanceTable");
  if (!tbody) return;

  const rows = [];
  for (let p = 1; p <= 8; p++) {
    const pData = periods[String(p)] || periods[p] || { count: 0, students: [] };
    const studentsArr = Array.isArray(pData.students) ? pData.students : [];
    const studentsHtml = studentsArr.length ? studentsArr.map((name) => `<span class="name-chip">${name}</span>`).join(" ") : '<span class="muted">—</span>';
    rows.push(`<tr><td><strong>Period ${p}</strong></td><td><span class="count-badge">${pData.count || 0}</span></td><td class="names-cell">${studentsHtml}</td></tr>`);
  }
  tbody.innerHTML = rows.join("");
};

const broadcastAttendanceUpdate = (data = null) => {
  try {
    localStorage.setItem("attendance:update", JSON.stringify({ timestamp: Date.now(), signature: buildAttendanceSignature(data) }));
  } catch (_) { }
};

const refreshActiveProfile = async () => {
  if (document.body.dataset.page !== "profile" || !currentProfileName) return;
  await renderProfileByName(currentProfileName, "profile-result");
  const month = getSelectedMonth() || new Date().toISOString().slice(0, 7);
  await computeStudentPeriodSummary(currentProfileName, month);
};

const refreshRealtimeViews = async () => {
  const page = document.body.dataset.page;
  if (page === "dashboard") {
    await Promise.allSettled([loadSelectedMonth(), updateDashboardStats(latestTodayAttendance)]);
  } else if (page === "home") {
    await updateDashboardStats(latestTodayAttendance);
  } else if (page === "profile") {
    await refreshActiveProfile();
  }
};

const applyTodayAttendanceData = async (data, { refreshViews = false } = {}) => {
  latestTodayAttendance = data;
  lastAttendanceSignature = buildAttendanceSignature(data);
  applyTodaySummary(data);
  renderTodayAttendanceRows(data);
  renderPeriodWiseAttendanceRows(data.periods || {});
  if (refreshViews) await refreshRealtimeViews();
  return data;
};

const syncTodayAttendance = async ({ force = false, refreshViews = false } = {}) => {
  if (attendanceSyncInFlight && !force) return latestTodayAttendance;
  attendanceSyncInFlight = true;
  try {
    const data = await fetchTodayAttendanceData();
    const changed = force || buildAttendanceSignature(data) !== lastAttendanceSignature;
    await applyTodayAttendanceData(data, { refreshViews: changed && refreshViews });
    return data;
  } catch (e) {
    console.error("Failed to sync today's attendance:", e);
    return latestTodayAttendance;
  } finally {
    attendanceSyncInFlight = false;
  }
};

const updateTodayPresentCount = async () => {
  await syncTodayAttendance();
};

/* ---------- period helpers ---------- */
// Load period timings from backend
const loadPeriodTimings = async () => {
  try {
    const res = await fetch(`${API_BASE}/period-timings`);
    periodTimings = await res.json();
  } catch (e) { console.error("Failed to load period timings:", e); }
};

// Get current period
const updateCurrentPeriod = async () => {
  try {
    const res = await fetch(`${API_BASE}/current-period`);
    const data = await res.json();
    currentPeriod = data.current_period;
    // Update UI elements showing current period
    const _period = $("currentPeriod");
    if (_period) {
      if (currentPeriod) {
        _period.textContent = `Period ${currentPeriod}`;
        _period.style.color = "#10b981";
      } else {
        _period.textContent = "No Active Period";
        _period.style.color = "#f97316";
      }
    }
  } catch (e) { console.error("Failed to get current period:", e); }
};

// Map time strings like "08:23:12" to a class period 1..8
const timeToPeriod = (timeStr) => {
  if (!timeStr) return null;
  const t = timeStr.split(":"); if (t.length < 2) return null;
  const hh = parseInt(t[0], 10);
  // Period windows: 08:00-08:59 -> 1, 09:00-09:59 -> 2, ... 15:00-15:59 -> 8
  if (hh >= 8 && hh <= 15) return Math.min(8, hh - 7);
  return null;
};

const getDaysInMonth = (monthStr) => {
  // monthStr expected as YYYY-MM
  if (!monthStr) return [];
  const [y, m] = monthStr.split("-").map((v) => parseInt(v, 10));
  if (!y || !m) return [];
  const days = new Date(y, m, 0).getDate();
  const arr = [];
  for (let d = 1; d <= days; d++) {
    arr.push(new Date(y, m - 1, d).toISOString().slice(0, 10));
  }
  return arr;
};

/* ---------- camera ---------- */
const startCamera = async () => {
  video = $("video"); canvas = $("canvas"); output = $("output"); scanState = $("scan-state");
  if (!video || !navigator.mediaDevices?.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    showMessage("Camera access denied", true);
  }
};
const captureImage = () => {
  // Fail-safe to avoid uncaught errors when the stream isn't ready
  if (!video || !canvas || !video.srcObject) {
    showMessage("Camera not ready. Allow access or click Start again.", true);
    return null;
  }
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg");
};

/* ---------- Face recognition (auto-mark) ---------- */
let registeredDescriptors = [];
const loadRecognitionModels = async () => {
  if (!window.faceapi) throw new Error('faceapi not available');
  const modelPath = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(modelPath);
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelPath);
    await faceapi.nets.faceRecognitionNet.loadFromUri(modelPath);
  } catch (e) {
    console.warn('Face-api models failed to load from CDN:', e);
    throw e;
  }
};

const loadRegisteredDescriptors = async () => {
  registeredDescriptors = [];
  try {
    const res = await fetch(`${API_BASE}/students`);
    const students = await res.json();
    // For each student, try fetching descriptor (stored in details as JSON or separate field)
    // Our backend stores descriptor in `details` or `descriptor` field if present; try GET /student/<name> for full info
    for (const s of students) {
      try {
        const p = await (await fetch(`${API_BASE}/student/${encodeURIComponent(s.name)}`)).json();
        if (p && p.descriptor) {
          const desc = Array.isArray(p.descriptor) ? p.descriptor : JSON.parse(p.descriptor || '[]');
          if (desc && desc.length) registeredDescriptors.push({ name: s.name, descriptor: new Float32Array(desc) });
        }
      } catch (_) { }
    }
  } catch (e) { console.warn('Failed to load registered descriptors', e); }
};

const euclideanDistance = (a, b) => {
  let sum = 0.0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
};

const speakName = (text) => {
  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }
};

let recognitionRunning = false;
const startAutoRecognition = async () => {
  if (recognitionRunning) return true;
  if (!window.faceapi) return;
  await loadRecognitionModels();
  await loadRegisteredDescriptors();
  recognitionRunning = true;
  const videoEl = $('video');
  if (!videoEl) return;
  // wait for video ready
  if (videoEl.readyState < 2) await new Promise((r) => videoEl.addEventListener('loadedmetadata', r, { once: true }));

  const detectLoop = async () => {
    if (!recognitionRunning) return;
    if (videoEl.paused || videoEl.ended) return setTimeout(detectLoop, 500);
    try {
      const detections = await faceapi.detectAllFaces(videoEl, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
      // For each descriptor, find best match
      for (const det of detections) {
        const desc = det.descriptor;
        let best = { name: null, dist: 999 };
        for (const r of registeredDescriptors) {
          const d = euclideanDistance(desc, r.descriptor);
          if (d < best.dist) best = { name: r.name, dist: d };
        }
        // threshold ~0.48 for tinyFaceDetector/faceRecognition
        if (best.name && best.dist < 0.48) {
          // mark attendance for best.name (idempotent on duplicate)
          try {
            const res = await fetch(`${API_BASE}/mark_attendance`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: best.name })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(data.recognized) && data.recognized.some((item) => item.status === "marked")) {
              await applyTodayAttendanceData(data);
              broadcastAttendanceUpdate(data);
            }
          } catch (e) { console.warn('Mark failed', e); }
        }
      }
    } catch (e) { console.warn('Recognition loop error', e); }
    requestAnimationFrame(detectLoop);
  };
  detectLoop();
  return true;
};

const stopAutoRecognition = () => { recognitionRunning = false; };

/* ---------- attendance ---------- */
const captureAndMarkAttendance = async () => {
  try {
    const image = captureImage();
    if (!image) return; // skip this tick if camera not ready

    // We now rely on startAutoRecognition loop for automated background marking.
    // If captureAndMarkAttendance is called manually (e.g. interval), we just scan once.
    let given_name = null;

    if (window.faceapi && registeredDescriptors.length > 0) {
      // detect using faceapi directly instead of asking user
      const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
      if (detection) {
        let best = { name: null, dist: 999 };
        for (const r of registeredDescriptors) {
          const d = euclideanDistance(detection.descriptor, r.descriptor);
          if (d < best.dist) best = { name: r.name, dist: d };
        }
        if (best.name && best.dist < 0.48) {
          given_name = best.name;
        }
      }
    }

    if (!given_name) {
      // Could not detect automatically. 
      return;
    }

    const resp = await fetch(`${API_BASE}/mark_attendance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, name: given_name }),
    });
    let data = {};
    try { data = await resp.json(); } catch (_) { data = {}; }

    if (!resp.ok) {
      const period = data.current_period;
      const msg = data.message || "Attendance failed";
      showMessage(msg, true);
      if (period !== null && period !== undefined) {
        const _period = $("currentPeriod");
        if (_period) _period.textContent = period ? `Period ${period}` : "No Active Period";
      }
      return;
    }

    // Update current period from response
    if (data.current_period !== undefined) {
      currentPeriod = data.current_period;
      const _period = $("currentPeriod");
      if (_period) {
        if (data.current_period) {
          _period.textContent = `Period ${data.current_period}`;
          _period.style.color = "#10b981";
        } else {
          _period.textContent = "No Active Period";
          _period.style.color = "#f97316";
        }
      }
    }

    // Process recognized results - filter only "marked" status
    const recognizedResults = data.recognized || [];
    const markedStudents = recognizedResults.filter((r) => r.status === "marked");
    const markedNames = markedStudents.map((r) => r.name);
    const uniqueMarked = markedNames.length;

    if (uniqueMarked > 0) {
      scannedCount += uniqueMarked;
      sessionMarkedCount += uniqueMarked;
      markedNames.forEach((n) => sessionUniqueSet.add(n));

      const period = data.current_period || "?";
      const todayCount = data.today_present || 0;
      const periodCount = data.period_counts && data.period_counts[period] ? data.period_counts[period] : 0;

      showMessage(`✓ Period ${period}: ${markedNames.join(", ")} marked (Total: ${todayCount}, This period: ${periodCount})`);
      speakName(`${markedNames.join(", ")} marked present`);

      const _fd = $("facesDetected"); if (_fd) _fd.textContent = scannedCount;
      const _sm = $("sessionMarked"); if (_sm) _sm.textContent = sessionMarkedCount;
      const _uniq = $("uniqueStudents"); if (_uniq) _uniq.textContent = sessionUniqueSet.size;

      // Update present counts
      const _todayPresent = $("todayPresent"); if (_todayPresent) _todayPresent.textContent = todayCount;
      const _statTodayPresent = $("statTodayPresent"); if (_statTodayPresent) _statTodayPresent.textContent = todayCount;
      const _periodCount = $("currentPeriodCount"); if (_periodCount && period !== "?") _periodCount.textContent = periodCount;

      await applyTodayAttendanceData(data, { refreshViews: true });
      broadcastAttendanceUpdate(data);
    } else {
      // No new students marked (duplicates or unknowns)
      const duplicates = recognizedResults.filter((r) => r.status === "duplicate");
      await applyTodayAttendanceData(data);
      if (duplicates.length > 0) {
        showMessage(`Already marked for today: ${duplicates.map((r) => r.name).join(", ")}`);
      }
    }
  } catch (e) {
    console.error('captureAndMarkAttendance error', e);
    showMessage((e?.message || e) + ' — Network or CORS error. Ensure backend is running and CORS is enabled.', true);
  }
};
const startAttendance = async () => {
  try {
    scannedCount = 0;
    sessionMarkedCount = 0;
    sessionUniqueSet = new Set();
    sessionStartTime = new Date();
    // start session timer
    if (sessionTimerInterval) clearInterval(sessionTimerInterval);
    const scanTimeEl = $("scanTime");
    const sessionDurationEl = $("sessionDuration");
    const scanRateEl = $("scanRate");
    sessionTimerInterval = setInterval(() => {
      if (!sessionStartTime) return;
      const diff = Math.floor((Date.now() - sessionStartTime.getTime()) / 1000);
      const hrs = String(Math.floor(diff / 3600)).padStart(2, "0");
      const mins = String(Math.floor((diff % 3600) / 60)).padStart(2, "0");
      const secs = String(diff % 60).padStart(2, "0");
      if (scanTimeEl) scanTimeEl.textContent = `${hrs}:${mins}:${secs}`;
      if (sessionDurationEl) sessionDurationEl.textContent = `${Math.floor(diff / 60)} min`;
      const minutes = Math.max(1, diff / 60);
      const avg = Math.round((sessionMarkedCount / minutes) * 10) / 10;
      if (scanRateEl) scanRateEl.textContent = `${avg}/min`;
    }, 1000);
    if (!video?.srcObject) await startCamera(); // ensure camera stream exists
    const res = await fetch(`${API_BASE}/start_attendance`, { method: "POST" });
    let data = {};
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) { showMessage(data.message || "Failed to start", true); return; }
    setScanState(true);
    showMessage("✓ Scanner running");
    try {
      await startAutoRecognition();
    } catch (e) {
      console.warn("Auto recognition could not start, continuing with timed scan.", e);
    }
    if (attendanceInterval) clearInterval(attendanceInterval);
    await captureAndMarkAttendance();
    attendanceInterval = setInterval(async () => {
      try { await captureAndMarkAttendance(); } catch (_) { }
    }, 3000);
  } catch (e) {
    showMessage(e.message || e, true);
  }
};
const stopAttendance = async () => {
  try {
    const res = await fetch(`${API_BASE}/stop_attendance`, { method: "POST" });
    const data = await res.json();
    showMessage(data.message || "Stopped");
  } catch (e) { showMessage(e.message || e, true); }
  setScanState(false);
  stopAutoRecognition();
  if (attendanceInterval) { clearInterval(attendanceInterval); attendanceInterval = null; }
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
  // final update UI
  const _sm = $("sessionMarked"); if (_sm) _sm.textContent = sessionMarkedCount || 0;
  const _uniq = $("uniqueStudents"); if (_uniq) _uniq.textContent = sessionUniqueSet.size || 0;
};

const resetSession = () => {
  scannedCount = 0;
  const _fd0 = $("facesDetected"); if (_fd0) _fd0.textContent = "0";
  sessionStartTime = null; if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
  sessionMarkedCount = 0; sessionUniqueSet = new Set();
  const _sm0 = $("sessionMarked"); if (_sm0) _sm0.textContent = "0";
  const _uniq0 = $("uniqueStudents"); if (_uniq0) _uniq0.textContent = "0";
  const _scanTime = $("scanTime"); if (_scanTime) _scanTime.textContent = "00:00:00";
  const _sessDur = $("sessionDuration"); if (_sessDur) _sessDur.textContent = "0 min";
  const _rate = $("scanRate"); if (_rate) _rate.textContent = "0/min";
  showMessage("Session reset. Ready.");
};
const exportSession = async () => {
  try {
    const res = await fetch(`${API_BASE}/get_today_attendance`);
    const data = await res.json();
    const today = data.date || new Date().toISOString().slice(0, 10);
    const todayRows = Array.isArray(data.records) ? data.records : [];
    if (!todayRows.length) return showMessage("No records to export", true);
    let csv = "Student,Roll,Course,Details,Date,Time,Status\n";
    todayRows.forEach((r) => {
      const safe = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
      csv += [
        safe(r.name),
        safe(r.roll),
        safe(r.course),
        safe(r.details),
        safe(r.date),
        safe(r.time),
        safe(r.status || "Present"),
      ].join(",") + "\n";
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `attendance_${today}.csv`; a.click();
    URL.revokeObjectURL(url);
    showMessage(`✓ Exported ${todayRows.length} records`);
  } catch (e) { showMessage(e.message || e, true); }
};
const updateTodayAttendance = async () => {
  if (latestTodayAttendance) {
    renderTodayAttendanceRows(latestTodayAttendance);
    return;
  }
  await syncTodayAttendance();
};

/* ---------- registration ---------- */
const registerStudent = async () => {
  try {
    const name = $("name")?.value.trim(); const details = $("details")?.value.trim();
    if (!name) return showMessage("Name required", true);
    if (!video?.srcObject) await startCamera();

    // Try to compute face descriptor via face-api (optional)
    let descriptorArr = null;
    if (window.faceapi) {
      try {
        await loadRecognitionModels();
        // wait for video metadata
        if (video.readyState < 2) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
        const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
        if (detection && detection.descriptor) descriptorArr = Array.from(detection.descriptor);
      } catch (e) { console.warn('Descriptor not computed', e); }
    }

    const image = captureImage();
    if (!image) return;
    const body = { name, image, details };
    if (descriptorArr) body.descriptor = descriptorArr;
    const resp = await fetch(`${API_BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await resp.json(); } catch (_) { data = {}; }
    if (!resp.ok) { showMessage(data.error || data.message || "Registration failed", true); return; }
    const msg = data.status === "registered" ? `Student registered: ${data.student?.name}` : (data.message || "Student registered");
    showMessage(msg);
    if ($("name")) $("name").value = ""; if ($("details")) $("details").value = "";
  } catch (e) { showMessage(e.message || e, true); }
};

/* ---------- profiles ---------- */
const profileHTML = (d) => {
  const leave = d.leave_dates?.length ? d.leave_dates.join(", ") : "No leave records";
  const pctColor = d.percentage >= 75 ? "#22c55e" : "#f43f5e";
  // Period stats summary
  const periodStats = d.period_stats || {};
  const periodRows = Object.keys(periodStats).map(p => `<tr><td>Period ${p}</td><td>${periodStats[p]}</td></tr>`).join("");
  // Per-day, per-period attendance
  const records = (d.records || []).map((r) => {
    const perPeriods = (r.periods || []).map(per => `P${per.period} <span style='color:#a1a1aa;font-size:12px;'>(${per.time})</span>`).join(", ");
    return `<tr><td>${r.date}</td><td>${r.periods.length}</td><td>${perPeriods}</td></tr>`;
  }).join("") || "<tr><td colspan='3'>No attendance records</td></tr>";
  return `
    <div class="profile-top">
      <div>
        <h3>${d.name}</h3>
        <p>${d.details || "Not provided"}</p>
        <p><strong style="color:${pctColor}; font-size:24px;">${d.percentage}%</strong> (${d.present}/${d.total} days)</p>
        <div id="periodSummary" style="margin-top:8px; font-size:14px; color:#a1a1aa;">Loading monthly period summary...</div>
        <p><strong>Leave:</strong> ${leave}</p>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:12px;">
      <table><thead><tr><th>Date</th><th>Periods Marked</th><th>Periods/Times</th></tr></thead><tbody>${records}</tbody></table>
    </div>
    <div class="table-wrap" style="margin-top:12px;">
      <table><thead><tr><th>Period</th><th>Total Present</th></tr></thead><tbody>${periodRows}</tbody></table>
    </div>
    <div style="margin-top:14px;"><button class="btn btn-primary" onclick="openAdminEdit()"><i class="fas fa-pen"></i> Edit</button></div>
  `;
};
const fetchStudentProfile = async (name) => {
  try {
    const res = await fetch(`${API_BASE}/student/${encodeURIComponent(name)}`);
    let data = {};
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) { 
      const errorMsg = data.error || data.message || "Student not found";
      showMessage(errorMsg, true); 
      return null; 
    }
    return data;
  } catch (e) { 
    showMessage("Error fetching student: " + (e?.message || e), true); 
    return null; 
  }
};
const renderProfileByName = async (name, targetId) => {
  const target = $(targetId); if (!name?.trim() || !target) return showMessage("Enter student name", true);
  try {
    const data = await fetchStudentProfile(name.trim());
    if (!data) { target.classList.add("hidden"); target.innerHTML = ""; return showMessage("Student not found", true); }
    currentProfileData = data; currentProfileName = data.name;
    target.innerHTML = profileHTML(data); target.classList.remove("hidden"); showMessage("Profile loaded");
    // populate monthly period summary for this student (uses selected month or current month)
    const month = getSelectedMonth() || new Date().toISOString().slice(0, 7);
    computeStudentPeriodSummary(data.name, month).catch(() => { });
  } catch (e) { target.classList.add("hidden"); target.innerHTML = ""; showMessage(e.message || e, true); }
};

const computeStudentPeriodSummary = async (name, month) => {
  const el = $("periodSummary"); if (!el) return;
  try {
    const m = month || new Date().toISOString().slice(0, 7);
    const res = await fetch(`${API_BASE}/report/month/${m}`);
    const rows = await res.json();
    const days = getDaysInMonth(m);
    // date -> set of periods attended
    const dayPeriods = {};
    days.forEach((d) => dayPeriods[d] = new Set());
    rows.forEach((r) => {
      const nm = r[0]; const date = r[1]; const time = r[2];
      if (nm !== name) return;
      const p = timeToPeriod(time); if (!p) return;
      if (!dayPeriods[date]) dayPeriods[date] = new Set();
      dayPeriods[date].add(p);
    });
    let totalPeriods = 0; let activeDays = 0;
    Object.keys(dayPeriods).forEach((d) => { const c = dayPeriods[d].size; if (c) activeDays++; totalPeriods += c; });
    const possible = days.length * 8;
    const pct = possible ? Math.round((totalPeriods / possible) * 100) : 0;
    el.innerHTML = `Periods attended this month: <strong>${totalPeriods}</strong> / ${possible} (${pct}%) — Active days: <strong>${activeDays}</strong> of ${days.length}`;
  } catch (e) { el.textContent = "Period summary not available"; }
};
const searchFromDashboard = () => renderProfileByName($("search-name")?.value || "", "student-profile");
const searchProfilePage = () => { renderProfileByName($("profile-search-name")?.value || "", "profile-result"); $("admin-edit")?.classList.add("hidden"); };

const renderDailyAttendanceEditor = (records = []) => {
  const box = $("daily-attendance-editor"); if (!box) return;
  const rows = records.map((r) => `
    <tr>
      <td>${r.date}</td>
      <td><input type="date" value="${r.date}" data-old="${r.date}" class="input"></td>
      <td><input type="time" step="1" value="${r.times && r.times[0] ? r.times[0].slice(0, 5) : ""}" data-old="${r.date}" class="input"></td>
      <td><button class="btn btn-success" data-save="${r.date}">Save</button><button class="btn btn-ghost" data-leave="${r.date}">Leave</button></td>
    </tr>
  `).join("") || "<tr><td colspan='4'>No attendance records yet</td></tr>";
  box.innerHTML = `<div class="daily-editor"><div class="table-wrap"><table><thead><tr><th>Original</th><th>New Date</th><th>Time</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div><div style="margin-top:10px;"><button class="btn btn-primary" id="add-today-record"><i class="fas fa-plus"></i> Add Today</button></div></div>`;
  box.classList.remove("hidden");

  box.querySelectorAll("[data-save]").forEach((btn) => btn.onclick = async () => {
    const old = btn.dataset.save;
    const newDate = box.querySelector(`input[type=date][data-old="${old}"]`)?.value;
    const newTime = box.querySelector(`input[type=time][data-old="${old}"]`)?.value;
    await saveDailyAttendance(old, newDate, newTime, true);
  });
  box.querySelectorAll("[data-leave]").forEach((btn) => btn.onclick = async () => {
    const old = btn.dataset.leave; await saveDailyAttendance(old, old, "09:00:00", false);
  });
  box.querySelector("#add-today-record").onclick = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toTimeString().slice(0, 8);
    await saveDailyAttendance(today, today, now, true);
  };
};

const showAdminModal = (onSubmit) => {
  let modal = $("admin-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "admin-modal";
    modal.className = "modal hidden";
    modal.innerHTML = `
      <div class="modal-content glass card">
        <h3><i class="fas fa-lock"></i> Admin Authentication</h3>
        <p>Please enter the admin password to proceed.</p>
        <input type="password" id="admin-modal-pwd" class="input" placeholder="Password">
        <div class="modal-actions" style="margin-top:15px; display:flex; gap:10px;">
          <button class="btn btn-primary" id="admin-modal-submit">Verify</button>
          <button class="btn btn-ghost" id="admin-modal-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // basic modal styling included via JS since we don't want to change style.css too much
    Object.assign(modal.style, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      backgroundColor: 'rgba(0,0,0,0.6)', zIndex: '9999', display: 'flex',
      alignItems: 'center', justifyContent: 'center', opacity: '0', transition: 'opacity 0.2s',
      pointerEvents: 'none'
    });
  }

  modal.style.display = 'flex';
  setTimeout(() => { modal.style.opacity = '1'; modal.style.pointerEvents = 'auto'; }, 10);
  const input = $("admin-modal-pwd");
  input.value = "";
  input.focus();

  const close = () => {
    modal.style.opacity = '0'; modal.style.pointerEvents = 'none';
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  };

  $("admin-modal-submit").onclick = () => { close(); onSubmit(input.value); };
  $("admin-modal-cancel").onclick = () => { close(); onSubmit(null); };
  input.onkeydown = (e) => { if (e.key === "Enter") $("admin-modal-submit").click(); if (e.key === "Escape") $("admin-modal-cancel").click(); };
};

const openAdminEdit = () => {
  if (!currentProfileName) return showMessage("Search student first", true);
  if (adminSessionPassword) {
    proceedOpenAdminEdit();
  } else {
    showAdminModal((pwd) => {
      if (!pwd) return;
      adminSessionPassword = pwd;
      proceedOpenAdminEdit();
    });
  }
};

const proceedOpenAdminEdit = () => {
  $("admin-edit")?.classList.remove("hidden");
  $("edit-current-name").value = currentProfileName;
  $("edit-details").value = currentProfileData?.details || "";
  $("edit-new-name").value = "";
  renderDailyAttendanceEditor(currentProfileData?.records || []);
};

const saveStudentUpdate = async () => {
  const name = $("edit-current-name")?.value?.trim(); if (!name) return showMessage("Current name required", true);

  const doSave = async (pwd) => {
    const body = {
      admin_password: pwd,
      name,
      new_name: $("edit-new-name")?.value?.trim() || null,
      details: $("edit-details")?.value?.trim(),
    };
    try {
      const res = await fetch(`${API_BASE}/student/update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let data = {};
      try { data = await res.json(); } catch (_) { data = {}; }
      if (!res.ok) { showMessage(data.message || "Update failed", true); return; }
      showMessage(data.message || "Updated");
      adminSessionPassword = pwd;
      closeEditMode();
      const lookup = body.new_name || name;
      renderProfileByName(lookup, "profile-result");
      await loadReport(getSelectedMonth());
    } catch (e) { showMessage(e.message || e, true); }
  };

  if (adminSessionPassword) doSave(adminSessionPassword);
  else showAdminModal(doSave);
};
const saveDailyAttendance = async (oldDate, newDate, newTime, present) => {
  const name = $("edit-current-name")?.value?.trim(); if (!name) return showMessage("Name missing", true);

  const doSave = async (pwd) => {
    if (!pwd) return;
    try {
      const res = await fetch(`${API_BASE}/student/attendance/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin_password: pwd, name, date: oldDate, new_date: newDate, time: newTime, new_time: newTime, present }),
      });
      let data = {};
      try { data = await res.json(); } catch (_) { data = {}; }
      if (!res.ok) { showMessage(data.message || "Daily update failed", true); return; }
      adminSessionPassword = pwd; showMessage(data.message || "Attendance updated");
      await syncTodayAttendance({ force: true });
      broadcastAttendanceUpdate(latestTodayAttendance);
    } catch (e) { showMessage(e?.message || e, true); return; }
    renderProfileByName(name, "profile-result"); await loadReport(getSelectedMonth());
  };

  if (adminSessionPassword) doSave(adminSessionPassword);
  else showAdminModal(doSave);
};
const bulkMarkLeave = async () => {
  if (!currentProfileName) return showMessage("Search student first", true);

  const doLeave = async (pwd) => {
    if (!pwd) return;
    const start = window.prompt("Start date (YYYY-MM-DD)"); const end = window.prompt("End date (YYYY-MM-DD)");
    if (!start || !end) return;
    const s = new Date(start), e = new Date(end); let count = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      try { await saveDailyAttendance(ds, ds, "09:00:00", false); count++; } catch (_) { }
    }
    adminSessionPassword = pwd; showMessage(`Marked ${count} days as leave`);
  };

  if (adminSessionPassword) doLeave(adminSessionPassword);
  else showAdminModal(doLeave);
};
const toggleAdvancedEditor = () => $("daily-attendance-editor")?.classList.toggle("hidden");
const closeEditMode = () => { $("admin-edit")?.classList.add("hidden"); adminSessionPassword = ""; };

/* ---------- dashboard ---------- */
const getSelectedMonth = () => { const sel = $("month-select"); return sel && sel.value !== "all" ? sel.value : ""; };
const loadMonths = async () => {
  const sel = $("month-select"); if (!sel) return;
  try {
    const res = await fetch(`${API_BASE}/report/months`);
    const months = await res.json();
    sel.innerHTML = `<option value="all">All months</option>${months.map((m) => `<option value="${m}">${m}</option>`).join("")}`;
  } catch (_) { }
};
const loadReport = async (month) => {
  const tbody = document.querySelector("#table tbody"); if (!tbody) return;
  try {
    const res = await fetch(month ? `${API_BASE}/report/month/${month}` : `${API_BASE}/report`);
    const rows = await res.json();
    const _rc2 = $("recordCount"); if (_rc2) _rc2.textContent = `${rows.length} record(s)`;
    const tableEl = document.querySelector("#table");
    if (month) {
      // Build per-day per-period counts for the selected month (show full month)
      const days = getDaysInMonth(month);
      // date -> period -> set(names)
      const dataMap = {};
      days.forEach((d) => { dataMap[d] = {}; for (let p = 1; p <= 8; p++) dataMap[d][p] = new Set(); });
      rows.forEach((r) => {
        const name = r[0]; const date = r[1]; const time = r[2];
        const p = timeToPeriod(time); if (!p) return;
        if (!dataMap[date]) dataMap[date] = {}; if (!dataMap[date][p]) dataMap[date][p] = new Set();
        dataMap[date][p].add(name);
      });
      // build header: Date, P1..P8, Total
      const headerCells = ["<th>Date</th>"]; for (let p = 1; p <= 8; p++) headerCells.push(`<th>P${p}</th>`);
      headerCells.push("<th>Total</th>");
      if (tableEl) tableEl.querySelector("thead").innerHTML = `<tr>${headerCells.join("")}</tr>`;
      const rowsHtml = days.map((d) => {
        const counts = []; let totalSet = new Set();
        for (let p = 1; p <= 8; p++) { const s = dataMap[d] && dataMap[d][p] ? dataMap[d][p] : new Set(); counts.push(`<td>${s.size}</td>`); s.forEach((n) => totalSet.add(n)); }
        return `<tr><td>${d}</td>${counts.join("")}<td><strong>${totalSet.size}</strong></td></tr>`;
      });
      tbody.innerHTML = rowsHtml.length ? rowsHtml.join("") : `<tr><td colspan="10" class="muted">No attendance records for this month</td></tr>`;
    } else {
      // Aggregate across all dates (do not show names) — list each date with P1..P8 and Total
      const dates = Array.from(new Set(rows.map((r) => r[1]))).sort();
      const dataMap = {}; dates.forEach((d) => { dataMap[d] = {}; for (let p = 1; p <= 8; p++) dataMap[d][p] = new Set(); });
      rows.forEach((r) => {
        const name = r[0]; const date = r[1]; const time = r[2]; const p = timeToPeriod(time);
        if (!p) return; if (!dataMap[date]) dataMap[date] = {}; if (!dataMap[date][p]) dataMap[date][p] = new Set();
        dataMap[date][p].add(name);
      });
      const headerCells = ["<th>Date</th>"]; for (let p = 1; p <= 8; p++) headerCells.push(`<th>Period ${p}</th>`); headerCells.push("<th>Total</th>");
      if (tableEl) tableEl.querySelector("thead").innerHTML = `<tr>${headerCells.join("")}</tr>`;
      const rowsHtml = dates.map((d) => {
        const counts = []; let totalSet = new Set();
        for (let p = 1; p <= 8; p++) { const s = dataMap[d] && dataMap[d][p] ? dataMap[d][p] : new Set(); counts.push(`<td>${s.size}</td>`); s.forEach((n) => totalSet.add(n)); }
        return `<tr><td>${d}</td>${counts.join("")}<td><strong>${totalSet.size}</strong></td></tr>`;
      });
      tbody.innerHTML = rowsHtml.length ? rowsHtml.join("") : `<tr><td colspan="10" class="muted">No attendance records</td></tr>`;
    }
  } catch (e) { showMessage(e.message || e, true); }
};

let attendanceChartInstance = null;
const renderAttendanceChart = (labels, dataPoints) => {
  const ctx = $("attendanceChart");
  if (!ctx || !window.Chart) return;

  if (attendanceChartInstance) {
    attendanceChartInstance.destroy();
  }

  Chart.defaults.color = "#a1a1aa";
  Chart.defaults.font.family = "'Inter', sans-serif";

  attendanceChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Daily Attendance',
        data: dataPoints,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#00e5ff',
        pointBorderColor: '#7c3aed',
        pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: '#00e5ff',
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          titleColor: '#fff',
          bodyColor: '#a5f3fc',
          borderColor: 'rgba(124, 58, 237, 0.3)',
          borderWidth: 1,
          padding: 10,
          displayColors: false
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { precision: 0 }
        },
        x: {
          grid: { display: false }
        }
      }
    }
  });
};
const loadSelectedMonth = () => loadReport(getSelectedMonth());
const loadPeriodWiseAttendance = async () => {
  if (latestTodayAttendance) {
    renderPeriodWiseAttendanceRows(latestTodayAttendance.periods || {});
    return;
  }
  await syncTodayAttendance();
  if (latestTodayAttendance) {
    renderPeriodWiseAttendanceRows(latestTodayAttendance.periods || {});
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/report/today/periods`);
    const data = await res.json();
    const periods = data.periods || {};
    const tbody = $("periodAttendanceTable");
    if (!tbody) return;

    const rows = [];
    for (let p = 1; p <= 8; p++) {
      const pData = periods[p] || { count: 0, students: [] };
      const studentsArr = pData.students || [];
      const studentsHtml = studentsArr.length ? studentsArr.map(n => `<span class="name-chip">${n}</span>`).join(' ') : '<span class="muted">—</span>';
      rows.push(`<tr><td><strong>Period ${p}</strong></td><td><span class="count-badge">${pData.count}</span></td><td class="names-cell">${studentsHtml}</td></tr>`);
    }
    tbody.innerHTML = rows.join("");
  } catch (e) { console.error("Failed to load period-wise attendance:", e); }
};

const updateDashboardStats = async (todayData = null) => {
  try {
    const data = todayData || latestTodayAttendance;
    if (data) {
      applyTodaySummary(data);
      renderPeriodWiseAttendanceRows(data.periods || {});
      if (!$("attendanceChart")) return;

      const reportsRes = await fetch(`${API_BASE}/report`);
      const reports = await reportsRes.json();
      const dateMap = {};
      reports.forEach((r) => {
        const date = r[1];
        if (!dateMap[date]) dateMap[date] = new Set();
        dateMap[date].add(r[0]);
      });
      const labels = Object.keys(dateMap).sort().slice(-14);
      const dataPoints = labels.map((date) => dateMap[date].size);
      if (labels.length === 0) renderAttendanceChart(['No Data'], [0]);
      else renderAttendanceChart(labels, dataPoints);
      return;
    }

    const studentsRes = await fetch(`${API_BASE}/students`); const students = await studentsRes.json();
    const reportsRes = await fetch(`${API_BASE}/report`); const reports = await reportsRes.json();
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = new Set(reports.filter((r) => r[1] === today).map((r) => r[0])).size;
    let avg = 0;
    for (const s of students) {
      try { const p = await (await fetch(`${API_BASE}/student/${encodeURIComponent(s.name)}`)).json(); avg += p.percentage || 0; } catch (_) { }
    }
    avg = students.length ? Math.round(avg / students.length) : 0;
    const classDays = new Set(reports.map((r) => r[1])).size;
    [["statTotalStudents", "totalStudents", students.length],
    ["statTodayPresent", "todayAttendance", todayCount],
    ["statClassDays", "classDays", classDays],
    ["statAvgAttendance", "avgAttendance", `${avg}%`]]
      .forEach(([id, alt, val]) => { if ($(id)) $(id).textContent = val; if ($(alt)) $(alt).textContent = val; });

    // Load period-wise attendance
    loadPeriodWiseAttendance();

    // Update chart on dashboard
    if ($("attendanceChart")) {
      // Build data points for chart from reports (last 30 days present)
      const dateMap = {};
      reports.forEach(r => {
        const date = r[1];
        if (!dateMap[date]) dateMap[date] = new Set();
        dateMap[date].add(r[0]);
      });
      const labels = Object.keys(dateMap).sort().slice(-14); // last 14 days
      const dataPoints = labels.map(d => dateMap[d].size);

      // If empty fill with placeholder
      if (labels.length === 0) {
        renderAttendanceChart(['No Data'], [0]);
      } else {
        renderAttendanceChart(labels, dataPoints);
      }
    }
  } catch (e) { console.error("Error updating stats", e); }
};
const refreshDashboard = () => { loadSelectedMonth(); updateDashboardStats(); };
const clearSearch = () => { const inp = $("search-name"); if (inp) inp.value = ""; $("student-profile")?.classList.add("hidden"); };

/* ---------- 3D background ---------- */
const init3DBackground = () => {
  const container = $("three-bg"); if (!container || !window.THREE) return;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1, 2000);
  camera.position.z = 900;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight); renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const geometry = new THREE.BufferGeometry();
  const particles = window.innerWidth > 900 ? 1800 : 900;
  const verts = [];
  for (let i = 0; i < particles; i++) { verts.push((Math.random() - 0.5) * 2200, (Math.random() - 0.5) * 2200, (Math.random() - 0.5) * 2200); }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  const material = new THREE.PointsMaterial({ color: 0x7c3aed, size: 2.2, opacity: 0.3, transparent: true });
  const points = new THREE.Points(geometry, material); scene.add(points);

  const material2 = new THREE.PointsMaterial({ color: 0x00e4ff, size: 1.6, opacity: 0.4, transparent: true });
  const points2 = new THREE.Points(geometry.clone(), material2); scene.add(points2);

  let mouseX = 0, mouseY = 0;
  document.addEventListener("mousemove", (e) => {
    mouseX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  const animate = () => {
    requestAnimationFrame(animate);
    points.rotation.y += 0.0006; points.rotation.x += 0.0002;
    points2.rotation.y -= 0.0004; points2.rotation.x -= 0.0002;
    camera.position.x += (mouseX * 240 - camera.position.x) * 0.05;
    camera.position.y += (mouseY * 240 - camera.position.y) * 0.05;
    camera.lookAt(scene.position);
    renderer.render(scene, camera);
  };
  animate();
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
};

/* ---------- init ---------- */
const initPage = () => {
  startCamera();
  init3DBackground();
  if (window.VanillaTilt) VanillaTilt.init(document.querySelectorAll("[data-tilt]"), { max: 8, speed: 400, glare: true, "max-glare": 0.2 });

  // Load period timings
  loadPeriodTimings();

  // Wire up attendance start/stop buttons if present
  const sb = $("startBtn"); const pb = $("stopBtn");
  if (sb) sb.onclick = () => startAttendance();
  if (pb) pb.onclick = () => stopAttendance();
  const page = document.body.dataset.page;

  // Load today's count on all pages
  syncTodayAttendance({ force: true, refreshViews: page === "home" || page === "profile" });
  updateCurrentPeriod();

  if (page === "attendance") {
    updateTodayAttendance();
    // Update period every 10 seconds on attendance page
    setInterval(updateCurrentPeriod, 10000);
  }
  if (page === "dashboard") {
    loadMonths().then(() => syncTodayAttendance({ force: true, refreshViews: true }));
    // Update period info on dashboard
    updateCurrentPeriod();
    setInterval(updateCurrentPeriod, 5000);
  }

  // Listen for attendance updates from other tabs/windows
  window.addEventListener("storage", (e) => {
    if (e.key !== "attendance:update") return;
    syncTodayAttendance({ force: true, refreshViews: true });
    updateCurrentPeriod();
  });

  // Poll the backend as the single source of truth for real-time attendance sync
  if (page === "attendance" || page === "dashboard" || page === "home" || page === "profile") {
    attendanceSyncInterval = setInterval(() => {
      syncTodayAttendance({ refreshViews: true });
    }, ATTENDANCE_SYNC_MS);
  }
};

window.startAttendance = startAttendance;
window.stopAttendance = stopAttendance;
window.registerStudent = registerStudent;
window.searchFromDashboard = searchFromDashboard;
window.searchProfilePage = searchProfilePage;
window.openAdminEdit = openAdminEdit;
window.saveStudentUpdate = saveStudentUpdate;
window.loadSelectedMonth = loadSelectedMonth;
window.resetSession = resetSession;
window.exportSession = exportSession;
window.bulkMarkLeave = bulkMarkLeave;
window.toggleAdvancedEditor = toggleAdvancedEditor;
window.closeEditMode = closeEditMode;
window.updateDashboardStats = updateDashboardStats;
window.refreshDashboard = refreshDashboard;
// Export wrapper used by dashboard button
window.exportRecords = exportSession;

document.addEventListener("DOMContentLoaded", initPage);
