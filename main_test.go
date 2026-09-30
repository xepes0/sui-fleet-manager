package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *app {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "fleet.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`CREATE TABLE servers(id INTEGER PRIMARY KEY,name TEXT,region TEXT,sui_url TEXT,token_cipher TEXT,komari_uuid TEXT);
		CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,action TEXT,server_id INTEGER,ok INTEGER,detail TEXT);`)
	if err != nil {
		t.Fatal(err)
	}
	if err := initializeJobStore(db); err != nil {
		t.Fatal(err)
	}
	if err := initializePreferenceStore(db); err != nil {
		t.Fatal(err)
	}
	return &app{db: db, key: bytes.Repeat([]byte{3}, 32), username: "admin", password: "long-test-password", dataDir: dir, client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, previews: map[string]preview{}}
}

func addTestServer(t *testing.T, a *app, panelURL string) int64 {
	t.Helper()
	token, err := a.seal("test-token")
	if err != nil {
		t.Fatal(err)
	}
	res, err := a.db.Exec(`INSERT INTO servers(name,region,sui_url,token_cipher,komari_uuid) VALUES(?,?,?,?,?)`, "JP-01", "Japan", panelURL+"/app/", token, "node-1")
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func postJSON(t *testing.T, h http.HandlerFunc, path string, input any) *httptest.ResponseRecorder {
	t.Helper()
	buf, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", path, bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func executePreviewTest(t *testing.T, a *app, previewID string) *httptest.ResponseRecorder {
	t.Helper()
	w := postJSON(t, a.executeHandler, "/api/operations/execute", map[string]string{"preview_id": previewID})
	if w.Code != http.StatusAccepted {
		return w
	}
	var started jobSummary
	if err := json.Unmarshal(w.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		req := httptest.NewRequest(http.MethodGet, "/api/jobs/"+started.ID, nil)
		statusWriter := httptest.NewRecorder()
		a.jobHandler(statusWriter, req)
		if statusWriter.Code != http.StatusOK {
			t.Fatalf("job status: %d %s", statusWriter.Code, statusWriter.Body.String())
		}
		var detail jobDetail
		if err := json.Unmarshal(statusWriter.Body.Bytes(), &detail); err != nil {
			t.Fatal(err)
		}
		if detail.Status == "completed" {
			result := httptest.NewRecorder()
			writeJSON(result, http.StatusOK, map[string]any{"results": detail.Results})
			return result
		}
		if detail.Status == "interrupted" {
			t.Fatalf("job interrupted: %+v", detail)
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not complete: %+v", detail)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestPreviewBackupAndDisableClient(t *testing.T) {
	a := testApp(t)
	client := map[string]any{"id": 7, "name": "alice", "enable": true, "remark": "keep me", "inbounds": []int{2}, "config": map[string]any{"vless": map[string]any{"uuid": "client-uuid"}}}
	saves := 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Token") != "test-token" {
			t.Errorf("missing token")
			http.Error(w, "unauthorized", 401)
			return
		}
		switch r.URL.Path {
		case "/app/apiv2/clients":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"clients": []any{client}}})
		case "/app/apiv2/getdb":
			w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 100)...))
		case "/app/apiv2/save":
			if err := r.ParseForm(); err != nil {
				t.Error(err)
			}
			if r.Form.Get("object") != "clients" || r.Form.Get("action") != "edit" {
				t.Errorf("unexpected form: %v", r.Form)
			}
			var updated map[string]any
			if err := json.Unmarshal([]byte(r.Form.Get("data")), &updated); err != nil {
				t.Error(err)
			}
			if updated["enable"] != false || updated["remark"] != "keep me" {
				t.Errorf("full client not retained: %v", updated)
			}
			client = updated
			saves++
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	w := postJSON(t, a.previewHandler, "/api/operations/preview", previewRequest{ServerIDs: []int64{id}, Action: "client_disable", ClientName: "alice"})
	if w.Code != 200 {
		t.Fatalf("preview: %d %s", w.Code, w.Body.String())
	}
	var p preview
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Changes) != 1 || p.Changes[0].Error != "" {
		t.Fatalf("unexpected preview: %+v", p)
	}
	w = executePreviewTest(t, a, p.ID)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("execute: %d %s", w.Code, w.Body.String())
	}
	if saves != 1 || client["enable"] != false {
		t.Fatalf("save count %d, client %v", saves, client)
	}
	files, err := filepath.Glob(filepath.Join(a.dataDir, "backups", "*.db"))
	if err != nil || len(files) != 1 {
		t.Fatalf("backup files: %v, %v", files, err)
	}
	data, err := os.ReadFile(files[0])
	if err != nil || !bytes.HasPrefix(data, []byte("SQLite format 3\x00")) {
		t.Fatalf("backup invalid: %v", err)
	}
	w = executePreviewTest(t, a, p.ID)
	if w.Code != 400 {
		t.Fatalf("preview should be single-use: %d", w.Code)
	}
}

func TestChangedClientStopsWrite(t *testing.T) {
	a := testApp(t)
	client := map[string]any{"id": 7, "name": "alice", "enable": true}
	backups := 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/clients":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"clients": []any{client}}})
		case "/app/apiv2/getdb":
			backups++
			w.Write([]byte("SQLite format 3\x00"))
		case "/app/apiv2/save":
			t.Error("save must not happen")
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	w := postJSON(t, a.previewHandler, "/api/operations/preview", previewRequest{ServerIDs: []int64{id}, Action: "client_disable", ClientName: "alice"})
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	client["remark"] = "changed"
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), "changed after preview") || backups != 0 {
		t.Fatalf("stale preview did not stop write: %s", w.Body.String())
	}
}

func TestInboundPatchPreviewAndBackup(t *testing.T) {
	a := testApp(t)
	inbound := map[string]any{"id": 5, "tag": "hy2", "type": "hysteria2", "listen_port": 8443, "keep": "value"}
	backups, saves := 0, 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/inbounds":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{inbound}}})
		case "/app/apiv2/getdb":
			backups++
			w.Write([]byte("SQLite format 3\x00"))
		case "/app/apiv2/save":
			if backups != 1 {
				t.Error("save before backup")
			}
			_ = r.ParseForm()
			if r.Form.Get("object") != "inbounds" || r.Form.Get("action") != "edit" {
				t.Errorf("form: %v", r.Form)
			}
			var changed map[string]any
			_ = json.Unmarshal([]byte(r.Form.Get("data")), &changed)
			if changed["listen_port"] != float64(9443) || changed["keep"] != "value" || changed["id"] != float64(5) {
				t.Errorf("wrong inbound: %v", changed)
			}
			inbound = changed
			saves++
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	patch := previewRequest{ServerIDs: []int64{id}, Action: "inbound_patch", InboundTag: "hy2", InboundPatch: json.RawMessage(`{"listen_port":9443}`)}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", patch)
	if w.Code != 200 {
		t.Fatalf("preview: %s", w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if len(p.Changes) != 1 || p.Changes[0].Error != "" {
		t.Fatalf("preview: %+v", p)
	}
	w = executePreviewTest(t, a, p.ID)
	if w.Code != 200 || saves != 1 || backups != 1 || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("execute: %s, saves=%d backups=%d", w.Body.String(), saves, backups)
	}
	w = httptest.NewRecorder()
	a.backupsHandler(w, httptest.NewRequest("GET", "/api/backups", nil))
	var entries []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil || len(entries) != 1 {
		t.Fatalf("backups: %s %v", w.Body.String(), err)
	}
	w = httptest.NewRecorder()
	a.backupDownloadHandler(w, httptest.NewRequest("GET", "/api/backups/"+entries[0].Name, nil))
	if w.Code != 200 || !bytes.HasPrefix(w.Body.Bytes(), []byte("SQLite format 3\x00")) {
		t.Fatalf("download: %d", w.Code)
	}
}

func TestKomariDashboardMapping(t *testing.T) {
	a := testApp(t)
	komari := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer key" {
			t.Error("Komari API key missing")
		}
		var req struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := map[string]any{"node-1": map[string]any{"name": "JP-01", "mem_total": 100}}
		if req.Method == "common:getNodesLatestStatus" {
			result = map[string]any{"node-1": map[string]any{"online": true, "cpu": 12, "ram": 25}}
		}
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
	defer komari.Close()
	a.komariURL = komari.URL
	a.komariKey = "key"
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"sbd": map[string]any{"running": true}}})
	}))
	defer panel.Close()
	addTestServer(t, a, panel.URL)
	w := httptest.NewRecorder()
	a.dashboardHandler(w, httptest.NewRequest("GET", "/api/dashboard", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"online":true`) || !strings.Contains(w.Body.String(), `"running":true`) {
		t.Fatalf("dashboard: %s", w.Body.String())
	}
}

func TestPanelRedirectDoesNotLeakToken(t *testing.T) {
	a := testApp(t)
	leaked := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = r.Header.Get("Token") != "" }))
	defer target.Close()
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	s, _ := a.getServer(id)
	_, err := a.suiGet(context.Background(), s, "clients")
	if err == nil || leaked {
		t.Fatalf("redirect not rejected or token leaked: %v %v", err, leaked)
	}
}

func TestAuthRejectsWrongCredentials(t *testing.T) {
	a := testApp(t)
	handler := a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	r := httptest.NewRequest("GET", "/api/servers", nil)
	r.SetBasicAuth("admin", "wrong")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	r = httptest.NewRequest("POST", "/api/servers", strings.NewReader(`{}`))
	r.SetBasicAuth("admin", "long-test-password")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://attacker.example")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestPanelURLKeepsWebPath(t *testing.T) {
	u, err := normalizeURL("https://example.com:2095/custom/path/")
	if err != nil || u != "https://example.com:2095/custom/path/" {
		t.Fatalf("%s %v", u, err)
	}
	if _, err := normalizeURL("https://user:pass@example.com/app/"); err == nil {
		t.Fatal("accepted URL credentials")
	}
}

func TestPublicListenRequiresTLS(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:18780", "[::1]:18780", "localhost:18780"} {
		if !loopbackListen(addr) {
			t.Fatalf("rejected loopback %s", addr)
		}
	}
	for _, addr := range []string{"0.0.0.0:18780", "[::]:18780", ":18780", "203.0.113.10:18780", "bad-address"} {
		if loopbackListen(addr) {
			t.Fatalf("accepted public or invalid listen %s", addr)
		}
	}
}


type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestKomariDoFallsBackToIPv4AfterDialFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	a := testApp(t)
	a.client = &http.Client{
		Timeout: 2 * time.Second,
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("simulated dial failure")}
		}),
	}

	target := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	req, err := http.NewRequest(http.MethodPost, target, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	res, err := a.komariDo(req)
	if err != nil {
		t.Fatalf("IPv4 fallback failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status %d", res.StatusCode)
	}
}
