from flask import Flask, request, jsonify
from flask_cors import CORS
import datetime
import functools
import sqlite3
import os
import json

app = Flask(__name__)
CORS(app)

# admin password (change as needed)
ADMIN_PASSWORD = "admin123"

# attendance session flag
attendance_sessions = {"running": False}

# SQLite database
DB_PATH = os.path.join(os.path.dirname(__file__), "data.db")
conn = sqlite3.connect(DB_PATH, check_same_thread=False)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# Create tables if not exist
cur.execute('''CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE COLLATE NOCASE,
    roll TEXT,
    course TEXT,
    details TEXT,
    percentage REAL DEFAULT 0
)''')
cur.execute('''CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    name TEXT,
    date TEXT,
    time TEXT
)''')
conn.commit()

# Helper DB helpers to avoid reusing the same cursor across requests
def db_fetchall(query, params=()):
    c = conn.cursor()
    c.execute(query, params)
    return c.fetchall()

def db_fetchone(query, params=()):
    c = conn.cursor()
    c.execute(query, params)
    return c.fetchone()

def db_execute(query, params=(), commit=False):
    c = conn.cursor()
    c.execute(query, params)
    if commit:
        conn.commit()
    return c

# Seed default students if table empty
cur.execute('SELECT COUNT(*) as c FROM students')
if cur.fetchone()[0] == 0:
    cur.executemany('INSERT INTO students (name, roll, course, percentage) VALUES (?,?,?,?)', [
        ("Alice", "001", "CS", 80), ("Bob", "002", "CS", 65)
    ])
    conn.commit()

# Ensure descriptor column exists
cur.execute("PRAGMA table_info(students)")
cols = [r[1] for r in cur.fetchall()]
if 'descriptor' not in cols:
    try:
        cur.execute('ALTER TABLE students ADD COLUMN descriptor TEXT')
        conn.commit()
    except Exception:
        pass


def now_parts():
    dt = datetime.datetime.now()
    return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M:%S")


def today_iso():
    return datetime.date.today().isoformat()


def time_to_period_local(tstr):
    try:
        hh = int(tstr.split(":")[0])
        if 8 <= hh <= 15:
            return min(8, hh - 7)
    except Exception:
        return None
    return None


def require_admin(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        data = request.json or {}
        pwd = data.get("admin_password") or request.headers.get("X-Admin-Password")
        if pwd != ADMIN_PASSWORD:
            return jsonify({"error": "admin password required"}), 403
        return fn(*args, **kwargs)
    return wrapper


def build_today_attendance_payload():
    today = today_iso()
    rows = db_fetchall(
        '''
        SELECT
            attendance.id,
            attendance.student_id,
            attendance.name,
            attendance.date,
            attendance.time,
            students.roll,
            students.course,
            students.details
        FROM attendance
        LEFT JOIN students ON students.id = attendance.student_id
        WHERE attendance.date=?
        ORDER BY attendance.time DESC, attendance.id DESC
        ''',
        (today,),
    )

    unique_rows = []
    unique_seen = set()
    period_students = {str(period): set() for period in range(1, 9)}

    for row in rows:
        student_key = row['student_id'] if row['student_id'] is not None else row['name'].strip().lower()
        if student_key not in unique_seen:
            unique_seen.add(student_key)
            unique_rows.append({
                "studentId": row['student_id'],
                "name": row['name'],
                "roll": row['roll'],
                "course": row['course'],
                "details": row['details'],
                "date": row['date'],
                "status": "Present",
                "time": row['time'],
                "timestamp": f"{row['date']}T{row['time']}",
            })

        period = time_to_period_local(row['time'])
        if period:
            period_students[str(period)].add(row['name'])

    total_students_row = db_fetchone('SELECT COUNT(*) AS total FROM students')
    class_days_row = db_fetchone('SELECT COUNT(DISTINCT date) AS total FROM attendance')
    avg_row = db_fetchone('SELECT AVG(COALESCE(percentage, 0)) AS avg_percentage FROM students')

    periods = {}
    for period in range(1, 9):
        key = str(period)
        students = sorted(period_students[key])
        periods[key] = {
            "count": len(students),
            "students": students,
        }

    latest_row = rows[0] if rows else None
    signature = f"{today}:{len(unique_rows)}:{latest_row['id'] if latest_row else 0}"

    return {
        "date": today,
        "attendance": [[row['name'], row['date'], row['time']] for row in rows],
        "records": unique_rows,
        "count": len(unique_rows),
        "today_present": len(unique_rows),
        "period_counts": {period: periods[period]["count"] for period in periods},
        "periods": periods,
        "summary": {
            "total_students": total_students_row['total'] if total_students_row else 0,
            "today_present": len(unique_rows),
            "class_days": class_days_row['total'] if class_days_row else 0,
            "avg_attendance": round(avg_row['avg_percentage'] or 0) if avg_row and avg_row['avg_percentage'] is not None else 0,
        },
        "last_updated": latest_row['timestamp'] if latest_row and 'timestamp' in latest_row.keys() else (f"{latest_row['date']}T{latest_row['time']}" if latest_row else None),
        "signature": signature,
    }


@app.route("/start_attendance", methods=["POST"])
def start_attendance():
    attendance_sessions["running"] = True
    return jsonify({"status": "started"})


@app.route("/stop_attendance", methods=["POST"])
def stop_attendance():
    attendance_sessions["running"] = False
    return jsonify({"status": "stopped"})


@app.route("/attendance", methods=["POST"])
@app.route("/mark_attendance", methods=["POST"])
def mark_attendance():
    """Mark attendance for an explicitly provided student name. Persists to SQLite."""
    data = request.json or {}
    given_name = (data.get("name") or "").strip()
    print(f"[MARK] Request received for name='{given_name}'")
    if not given_name:
        print("[MARK] ERROR: name is empty")
        return jsonify({"recognized": [], "message": "name required to mark attendance"}), 400

    date, time = now_parts()
    today = today_iso()
    current_period = time_to_period_local(time)
    print(f"[MARK] date={date} time={time} today={today} period={current_period}")

    # find student (case-insensitive)
    row = db_fetchone('SELECT id, name FROM students WHERE lower(name)=lower(?)', (given_name,))
    if not row:
        print(f"[MARK] ERROR: Student '{given_name}' not found in DB")
        return jsonify({"recognized": [], "message": "unknown student"}), 404

    student_id = row['id']
    student_name = row['name']
    print(f"[MARK] Found student: id={student_id} name={student_name}")

    # prevent duplicate attendance for the same student on the same day
    existing = db_fetchone(
        'SELECT id, time FROM attendance WHERE student_id=? AND date=? ORDER BY time DESC, id DESC LIMIT 1',
        (student_id, today),
    )
    if existing:
        print(f"[MARK] DUPLICATE: {student_name} already marked at {existing['time']} today")
        payload = build_today_attendance_payload()
        payload.update({
            "recognized": [{"name": student_name, "status": "duplicate"}],
            "message": "attendance already marked for today",
            "current_period": current_period,
        })
        return jsonify(payload), 200

    db_execute('INSERT INTO attendance (student_id, name, date, time) VALUES (?,?,?,?)', (student_id, student_name, date, time), commit=True)
    print(f"[MARK] SUCCESS: Inserted attendance for {student_name} on {date} at {time}")
    payload = build_today_attendance_payload()
    print(f"[MARK] Today's count after insert: {payload.get('count', 0)}")
    payload.update({
        "recognized": [{"name": student_name, "status": "marked"}],
        "message": "attendance marked",
        "current_period": current_period,
    })
    return jsonify(payload)


@app.route("/register", methods=["POST"])
def register():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    roll = data.get("roll") or ""
    details = data.get("details") or ""
    descriptor = data.get("descriptor")
    if not name:
        return jsonify({"error": "name required"}), 400
    try:
        c = db_execute('INSERT INTO students (name, roll, details, descriptor) VALUES (?,?,?,?)', (name, roll, details, json.dumps(descriptor) if descriptor is not None else None), commit=True)
        sid = c.lastrowid
        student = {"name": name, "roll": roll, "id": sid, "percentage": 0}
        return jsonify({"status": "registered", "student": student})
    except Exception as e:
        return jsonify({"error": "student already registered or invalid"}), 400


@app.route("/students", methods=["GET"])
def get_students():
    rows = db_fetchall('SELECT id, name, roll, percentage FROM students ORDER BY name')
    return jsonify([{"id": r['id'], "name": r['name'], "roll": r['roll'], "percentage": r['percentage']} for r in rows])


@app.route("/student/<name>", methods=["GET"])
def get_student(name):
    s = db_fetchone('SELECT * FROM students WHERE lower(name)=lower(?)', (name,))
    if s:
        sid = s['id']
        # records for this student - group by date and collect all periods for that date
        rows = db_fetchall('SELECT date, time FROM attendance WHERE student_id=? ORDER BY date DESC, time DESC', (sid,))
        
        # Group records by date
        date_records = {}
        for r in rows:
            date = r['date']
            time = r['time']
            period = time_to_period_local(time)
            if date not in date_records:
                date_records[date] = []
            if period:
                date_records[date].append({"period": period, "time": time})
        
        # Convert to list format expected by frontend
        records = []
        for date in sorted(date_records.keys(), reverse=True):
            periods = date_records[date]
            times = [p["time"] for p in periods]
            records.append({"date": date, "periods": periods, "times": times})
        
        # compute present/total/percentage naive
        days_row = db_fetchone('SELECT COUNT(DISTINCT date) as days FROM attendance WHERE student_id=?', (sid,))
        days = days_row['days'] or 0
        total_days = len(set([r['date'] for r in rows]))
        descriptor_val = s['descriptor'] if 'descriptor' in s.keys() else None
        try:
            descriptor_parsed = json.loads(descriptor_val) if descriptor_val else None
        except Exception:
            descriptor_parsed = None
        profile = {"name": s['name'], "roll": s['roll'], "id": sid, "percentage": s['percentage'] or 0, "present": days, "total": total_days, "records": records, "period_stats": {}, "leave_dates": [], "descriptor": descriptor_parsed}
        return jsonify(profile)
    return jsonify({"error": "not found"}), 404


@app.route("/student/update", methods=["POST"])
@require_admin
def update_student():
    data = request.json or {}
    name = data.get("name")
    new_name = data.get("new_name")
    s = db_fetchone('SELECT * FROM students WHERE name=?', (name,))
    if s:
        if new_name:
            db_execute('UPDATE students SET name=? WHERE id=?', (new_name, s['id']), commit=True)
        if data.get('details') is not None:
            db_execute('UPDATE students SET details=? WHERE id=?', (data.get('details'), s['id']), commit=True)
        updated = db_fetchone('SELECT * FROM students WHERE id=?', (s['id'],))
        return jsonify({"status": "updated", "student": {"id": updated['id'], "name": updated['name'], "roll": updated['roll']}})
    return jsonify({"error": "not found"}), 404


@app.route("/student/attendance/update", methods=["POST"])
@require_admin
def update_attendance():
    data = request.json or {}
    name = data.get("name")
    date = data.get("date")
    new_date = data.get("new_date") or date
    new_time = data.get("new_time") or data.get("time")
    present = data.get("present", True)

    modified = 0
    # find student id
    s = db_fetchone('SELECT id FROM students WHERE name=?', (name,))
    if not s:
        return jsonify({"error": "not found"}), 404
    sid = s['id']

    if present:
        # update existing records for that date to new_date/new_time by deleting old and inserting new
        db_execute('DELETE FROM attendance WHERE student_id=? AND date=?', (sid, date), commit=True)
        db_execute('INSERT INTO attendance (student_id, name, date, time) VALUES (?,?,?,?)', (sid, name, new_date, new_time), commit=True)
        modified = 1
    else:
        c = db_execute('DELETE FROM attendance WHERE student_id=? AND date=?', (sid, date), commit=True)
        modified = c.rowcount
    return jsonify({"status": "ok", "modified": modified})


@app.route("/report", methods=["GET"])
def report():
    rows = db_fetchall('SELECT name, date, time FROM attendance ORDER BY date DESC, time DESC')
    return jsonify([[r['name'], r['date'], r['time']] for r in rows])


@app.route("/report/months", methods=["GET"])
def report_months():
    rows = db_fetchall('SELECT DISTINCT substr(date,1,7) as ym FROM attendance ORDER BY ym DESC')
    return jsonify([r['ym'] for r in rows if r['ym']])


@app.route("/report/month/<ym>", methods=["GET"])
def report_month(ym):
    rows = db_fetchall('SELECT name, date, time FROM attendance WHERE date LIKE ? ORDER BY date DESC, time DESC', (ym + '%',))
    return jsonify([[r['name'], r['date'], r['time']] for r in rows])


@app.route("/report/today", methods=["GET"])
def report_today():
    return jsonify(build_today_attendance_payload())


@app.route("/get_today_attendance", methods=["GET"])
def get_today_attendance():
    payload = build_today_attendance_payload()
    print(f"[GET_TODAY] date={payload.get('date')} count={payload.get('count')} records={len(payload.get('records', []))}")
    return jsonify(payload)


@app.route("/report/today/periods", methods=["GET"])
def report_today_periods():
    payload = build_today_attendance_payload()
    return jsonify({"periods": payload["periods"]})


@app.route("/period-timings", methods=["GET"])
def period_timings():
    timings = [
        {"period": i, "start": f"0{7+i}:00:00" if (7+i)<10 else f"{7+i}:00:00", "end": f"0{7+i}:59:59" if (7+i)<10 else f"{7+i}:59:59"}
        for i in range(1,9)
    ]
    return jsonify(timings)


@app.route("/current-period", methods=["GET"])
def current_period():
    hh = datetime.datetime.now().hour
    cp = None
    if 8 <= hh <= 15:
        cp = min(8, hh - 7)
    return jsonify({"current_period": cp})


@app.route("/reset_db", methods=["POST"])
@require_admin
def reset_db():
    cur.execute('DELETE FROM attendance')
    cur.execute('DELETE FROM students')
    conn.commit()
    return jsonify({"status": "reset", "students": 0, "records": 0})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
