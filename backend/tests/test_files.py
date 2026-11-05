import os
import time
from pathlib import Path

from localflow import jobctl
from localflow.modules.files import ops, rules
from test_api import AUTH, client, wait_job  # noqa: F401  (client is a fixture)


def post(client, path, body, status=None):
    r = client.post(path, headers=AUTH, json=body)
    if status is not None:
        assert r.status_code == status, r.text
    return r


def post_job(client, path, body):
    r = post(client, path, body, 202)
    return wait_job(client, r.json()["id"], timeout=60)


# ---- job progress / cancel ----------------------------------------------------------------------


def test_running_job_reports_progress_and_can_be_cancelled(client):
    job = client.app.state.jobs.submit("selftest", jobctl._selftest_sleep, 60)
    deadline = time.time() + 20
    progress = None
    while time.time() < deadline and not progress:
        progress = client.get(f"/jobs/{job.id}", headers=AUTH).json()["progress"]
        time.sleep(0.1)
    assert progress and progress["message"] == "tick"
    assert client.post(f"/jobs/{job.id}/cancel", headers=AUTH).json() == {"cancelled": True}
    final = wait_job(client, job.id, timeout=20)
    assert final["state"] == "cancelled"


# ---- bulk rename --------------------------------------------------------------------------------


def test_rename_preview_apply_and_undo(client, tmp_path):
    folder = tmp_path / "photos"
    folder.mkdir()
    for n in ("IMG_001.jpg", "IMG_002.jpg", "notes.txt"):
        (folder / n).write_text("x")
    body = {"folder": str(folder), "pattern": r"IMG_(\d+)", "replacement": r"holiday-{n:03}", "regex": True}
    preview = post(client, "/files/rename/preview", body, 200).json()
    assert [Path(p["target"]).name for p in preview] == ["holiday-001.jpg", "holiday-002.jpg"]
    assert (folder / "IMG_001.jpg").exists()  # preview changes nothing

    result = post(client, "/files/rename/apply", body, 200).json()
    assert result["renamed"] == 2
    assert sorted(os.listdir(folder)) == ["holiday-001.jpg", "holiday-002.jpg", "notes.txt"]

    hist = client.get("/history", headers=AUTH).json()
    assert [h["op"] for h in hist] == ["move", "move"]
    for h in hist:
        assert client.post(f"/history/{h['id']}/undo", headers=AUTH).status_code == 200
    assert sorted(os.listdir(folder)) == ["IMG_001.jpg", "IMG_002.jpg", "notes.txt"]


def test_rename_conflicts_are_flagged_and_skipped(tmp_path):
    (tmp_path / "a.txt").write_text("1")
    (tmp_path / "b.txt").write_text("2")
    (tmp_path / "c.txt").write_text("3")
    plan = ops.rename_plan(tmp_path, "[ab]", "x", use_regex=True)
    assert {p["conflict"] for p in plan} == {"duplicate target"}
    plan2 = ops.rename_plan(tmp_path, "a", "c")
    assert plan2[0]["conflict"] == "target exists"
    logged = []
    res = ops.apply_renames(plan2, lambda *a: logged.append(a))
    assert res["renamed"] == 0 and logged == [] and (tmp_path / "a.txt").exists()


def test_rename_invalid_regex_is_422(client, tmp_path):
    r = post(client, "/files/rename/preview", {"folder": str(tmp_path), "pattern": "(", "regex": True})
    assert r.status_code == 422


# ---- junk sweeper + quarantine ------------------------------------------------------------------


def test_dev_junk_scan_quarantine_and_undo(client, tmp_path):
    proj = tmp_path / "proj"
    (proj / "node_modules" / "pkg").mkdir(parents=True)
    (proj / "node_modules" / "pkg" / "i.js").write_text("x" * 5000)
    (proj / "src" / "__pycache__").mkdir(parents=True)
    (proj / "src" / "__pycache__" / "m.pyc").write_text("y" * 100)
    (proj / "src" / "keep.py").write_text("print(1)")
    (proj / "target").mkdir()  # no Cargo.toml next to it -> not junk
    (proj / "target" / "keep.txt").write_text("z")

    job = post_job(client, "/files/junk/scan", {"root": str(tmp_path)})
    assert job["state"] == "done", job
    kinds = {Path(i["path"]).name for i in job["result"]["items"]}
    assert kinds == {"node_modules", "__pycache__"}
    assert job["result"]["total_size"] >= 5100

    paths = [i["path"] for i in job["result"]["items"]]
    res = post(client, "/files/quarantine", {"paths": paths}, 200).json()
    assert res["moved"] == 2 and res["freed_bytes"] >= 5100
    assert not (proj / "node_modules").exists()
    assert (proj / "src" / "keep.py").exists() and (proj / "target" / "keep.txt").exists()
    assert client.get("/files/quarantine", headers=AUTH).json()[0]["size"] >= 5100

    for h in client.get("/history", headers=AUTH).json():
        assert client.post(f"/history/{h['id']}/undo", headers=AUTH).status_code == 200
    assert (proj / "node_modules" / "pkg" / "i.js").exists()


def test_quarantine_rejects_paths_outside_roots_and_protected(client, tmp_path):
    assert post(client, "/files/quarantine", {"paths": ["C:/Windows/System32"]}).status_code == 403
    assert ops.is_protected(Path.home()) and ops.is_protected(Path.home() / "Documents")
    assert ops.is_protected(Path(Path.home().anchor))
    assert not ops.is_protected(tmp_path)


def test_purge_only_removes_old_batches(client, tmp_path):
    f = tmp_path / "x" / "f.bin"
    f.parent.mkdir()
    f.write_bytes(b"1" * 10)
    post(client, "/files/quarantine", {"paths": [str(f)]}, 200)
    assert post(client, "/files/quarantine/purge", {"older_than_days": 1}, 200).json()["removed_batches"] == 0
    assert post(client, "/files/quarantine/purge", {"older_than_days": 0}, 200).json()["removed_batches"] == 1
    assert client.get("/files/quarantine", headers=AUTH).json() == []


# ---- temp cleaner -----------------------------------------------------------------------------


def test_scan_temp_respects_age(tmp_path):
    old, new = tmp_path / "old.tmp", tmp_path / "new.tmp"
    old.write_text("a" * 100)
    new.write_text("b" * 100)
    two_days_ago = time.time() - 2 * 86400
    os.utime(old, (two_days_ago, two_days_ago))
    res = ops.scan_temp([str(tmp_path)], older_than_days=1)
    assert [Path(i["path"]).name for i in res["items"]] == ["old.tmp"] and res["total_size"] == 100


# ---- disk usage -----------------------------------------------------------------------------------


def test_usage_tree(client, tmp_path):
    tmp_path = tmp_path / "scan"  # keep the engine's own _data folder out of the measurement
    (tmp_path / "big").mkdir(parents=True)
    (tmp_path / "big" / "a.bin").write_bytes(b"0" * 4000)
    (tmp_path / "small").mkdir()
    (tmp_path / "small" / "b.bin").write_bytes(b"0" * 100)
    (tmp_path / "top.bin").write_bytes(b"0" * 50)
    job = post_job(client, "/files/usage", {"path": str(tmp_path), "depth": 2})
    tree = job["result"]
    assert tree["size"] == 4150
    names = [c["name"] for c in tree["children"]]
    assert names[0] == "big" and set(names) >= {"big", "small", "top.bin"}
    assert tree["children"][0]["size"] == 4000


# ---- duplicates ---------------------------------------------------------------------------------


def test_duplicates(client, tmp_path):
    tmp_path = tmp_path / "scan"  # keep the engine's own _data folder out of the scan
    tmp_path.mkdir()
    (tmp_path / "a.bin").write_bytes(b"same" * 1000)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "copy.bin").write_bytes(b"same" * 1000)
    (tmp_path / "other.bin").write_bytes(b"diff" * 1000)  # same size, different content
    (tmp_path / "tiny1.txt").write_text("a")
    (tmp_path / "tiny2.txt").write_text("a")  # below min_size
    job = post_job(client, "/files/duplicates", {"roots": [str(tmp_path)]})
    groups = job["result"]["groups"]
    assert len(groups) == 1
    assert sorted(Path(p).name for p in groups[0]["files"]) == ["a.bin", "copy.bin"]
    assert job["result"]["wasted_bytes"] == 4000


# ---- rule engine / Downloads Autopilot --------------------------------------------------------


def rule_body(folder, dest, **kw):
    return {"name": "pdfs", "folder": str(folder), "dest": str(dest), "extensions": ["pdf"], **kw}


def test_rule_run_now_moves_matching_files_and_undo(client, tmp_path):
    dl, dest = tmp_path / "dl", tmp_path / "docs" / "{ext}"
    dl.mkdir()
    (dl / "a.pdf").write_text("1")
    (dl / "b.PDF").write_text("2")
    (dl / "c.txt").write_text("3")
    (dl / "d.pdf.crdownload").write_text("partial")
    rule = post(client, "/files/rules", rule_body(dl, dest), 201).json()
    assert rule["extensions"] == ["pdf"]
    res = post(client, f"/files/rules/{rule['id']}/run", {}, 200).json()
    assert res["moved"] == 2
    assert sorted(os.listdir(tmp_path / "docs" / "pdf")) == ["a.pdf", "b.PDF"]
    assert sorted(os.listdir(dl)) == ["c.txt", "d.pdf.crdownload"]
    for h in client.get("/history", headers=AUTH).json():
        client.post(f"/history/{h['id']}/undo", headers=AUTH)
    assert sorted(os.listdir(dl)) == ["a.pdf", "b.PDF", "c.txt", "d.pdf.crdownload"]


def test_rule_conditions_and_validation(client, tmp_path):
    dl = tmp_path / "dl"
    dl.mkdir()
    assert post(client, "/files/rules", rule_body(dl, tmp_path / "o", name_regex="(")).status_code == 422
    assert post(client, "/files/rules", rule_body(tmp_path / "missing", tmp_path / "o")).status_code == 404
    assert post(client, "/files/rules", rule_body(dl, "C:/Windows/x")).status_code == 403
    big = rule_body(dl, tmp_path / "o", min_size=100, extensions=[], name_regex="^inv")
    rule = post(client, "/files/rules", big, 201).json()
    (dl / "invoice.bin").write_bytes(b"0" * 200)
    (dl / "invoice-small.bin").write_bytes(b"0" * 10)
    (dl / "other.bin").write_bytes(b"0" * 200)
    assert post(client, f"/files/rules/{rule['id']}/run", {}, 200).json()["moved"] == 1
    assert client.delete(f"/files/rules/{rule['id']}", headers=AUTH).status_code == 200
    assert client.get("/files/rules", headers=AUTH).json() == []


def test_watcher_moves_new_files(client, tmp_path, monkeypatch):
    monkeypatch.setattr(rules, "SETTLE_SECONDS", 0.2)
    dl, dest = tmp_path / "dl", tmp_path / "sorted"
    dl.mkdir()
    post(client, "/files/rules", rule_body(dl, dest), 201)
    (dl / "arrived.pdf").write_text("hello")
    deadline = time.time() + 15
    while time.time() < deadline and not (dest / "arrived.pdf").exists():
        time.sleep(0.2)
    assert (dest / "arrived.pdf").exists() and not (dl / "arrived.pdf").exists()
