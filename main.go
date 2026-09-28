package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed web/*
var assets embed.FS

type server struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Region      string `json:"region"`
	SUIURL      string `json:"sui_url"`
	KomariUUID  string `json:"komari_uuid"`
	HasToken    bool   `json:"has_token"`
	TokenCipher string `json:"-"`
}

type app struct {
	db              *sql.DB
	key             []byte
	username        string
	password        string
	komariURL       string
	komariPublicURL string
	komariKey       string
	client          *http.Client
	dataDir         string
	mu              sync.Mutex
	previews        map[string]preview
}

type previewRequest struct {
	ServerIDs              []int64                     `json:"server_ids"`
	Action                 string                      `json:"action"`
	ClientName             string                      `json:"client_name"`
	Client                 json.RawMessage             `json:"client"`
	InboundsByServer       map[string][]int            `json:"inbounds_by_server"`
	InboundTag             string                      `json:"inbound_tag"`
	InboundPatch           json.RawMessage             `json:"inbound_patch"`
	InboundPublicServer    string                      `json:"inbound_public_server"`
	InboundPublicPort      int                         `json:"inbound_public_port"`
	Object                 json.RawMessage             `json:"object"`
	TLSRef                 string                      `json:"tls_ref"`
	SourceTag              string                      `json:"source_tag"`
	ObjectOverrides        json.RawMessage             `json:"object_overrides"`
	ObjectTag              string                      `json:"object_tag"`
	ObjectPatch            json.RawMessage             `json:"object_patch"`
	RouteRule              json.RawMessage             `json:"route_rule"`
	RouteIndex             *int                        `json:"route_index"`
	RoutePosition          string                      `json:"route_position"`
	ConfigTarget           string                      `json:"config_target"`
	ConfigMode             string                      `json:"config_mode"`
	ConfigIdentity         string                      `json:"config_identity"`
	ConfigPatch            []configPatchOp             `json:"config_patch"`
	ConfigInboundTags      []string                    `json:"config_inbound_tags"`
	ConfigInboundsByServer map[string][]string         `json:"config_inbounds_by_server"`
	ConfigTLSName          string                      `json:"config_tls_name"`
	ConfigPublicAddrs      map[string]configPublicAddr `json:"config_public_addrs"`
	ConfigSourceTag        string                      `json:"config_source_tag"`
}

type configPublicAddr struct {
	Server string `json:"server"`
	Port   int    `json:"port"`
}

type change struct {
	ServerID          int64           `json:"server_id"`
	ServerName        string          `json:"server_name"`
	Action            string          `json:"action"`
	Before            json.RawMessage `json:"before,omitempty"`
	After             json.RawMessage `json:"after,omitempty"`
	Error             string          `json:"error,omitempty"`
	Fingerprint       string          `json:"-"`
	ServerFingerprint string          `json:"-"`
	Payload           json.RawMessage `json:"-"`
}

type preview struct {
	ID      string         `json:"id"`
	Expires time.Time      `json:"expires"`
	Request previewRequest `json:"-"`
	Changes []change       `json:"changes"`
}

type outcome struct {
	ServerID int64  `json:"server_id"`
	Name     string `json:"name"`
	OK       bool   `json:"ok"`
	Message  string `json:"message"`
	Backup   string `json:"backup,omitempty"`
}

func main() {
	username := os.Getenv("FLEET_USER")
	password := os.Getenv("FLEET_PASSWORD")
	key, err := base64.StdEncoding.DecodeString(os.Getenv("FLEET_MASTER_KEY"))
	if username == "" || len(password) < 16 || err != nil || len(key) != 32 {
		log.Fatal("set FLEET_USER, FLEET_PASSWORD (at least 16 characters), and FLEET_MASTER_KEY (base64 of 32 bytes)")
	}
	dataDir := os.Getenv("FLEET_DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatal(err)
	}
	if err := os.Chmod(dataDir, 0700); err != nil {
		log.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "fleet.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS servers (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, region TEXT NOT NULL,
		sui_url TEXT NOT NULL, token_cipher TEXT NOT NULL, komari_uuid TEXT NOT NULL DEFAULT '');
		CREATE TABLE IF NOT EXISTS audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL,
		server_id INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL);`); err != nil {
		log.Fatal(err)
	}
	if err := initializeTemplateStore(db); err != nil {
		log.Fatal(err)
	}
	if err := initializeJobStore(db); err != nil {
		log.Fatal(err)
	}
	_ = os.Chmod(filepath.Join(dataDir, "fleet.db"), 0600)
	a := &app{db: db, key: key, username: username, password: password, komariURL: strings.TrimRight(os.Getenv("KOMARI_URL"), "/"), komariPublicURL: strings.TrimRight(os.Getenv("KOMARI_PUBLIC_URL"), "/"), komariKey: os.Getenv("KOMARI_API_KEY"), dataDir: dataDir, previews: make(map[string]preview), client: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if a.komariURL != "" {
		if _, err := normalizeURL(a.komariURL); err != nil {
			log.Fatalf("KOMARI_URL: %v", err)
		}
	}
	if a.komariPublicURL != "" {
		_, err := normalizeURL(a.komariPublicURL)
		u, parseErr := url.Parse(a.komariPublicURL)
		if err != nil || parseErr != nil || isLoopbackHost(u.Hostname()) {
			log.Fatal("KOMARI_PUBLIC_URL must be a valid public HTTP(S) URL")
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/api/servers", a.serversHandler)
	mux.HandleFunc("/api/servers/", a.serverHandler)
	mux.HandleFunc("/api/dashboard", a.dashboardHandler)
	mux.HandleFunc("/api/komari/nodes", a.komariNodesHandler)
	mux.HandleFunc("/api/komari/ping-history", a.komariPingHistoryHandler)
	mux.HandleFunc("/api/operations/preview", a.previewHandler)
	mux.HandleFunc("/api/operations/execute", a.executeHandler)
	mux.HandleFunc("/api/jobs", a.jobsHandler)
	mux.HandleFunc("/api/jobs/", a.jobHandler)
	mux.HandleFunc("/api/audit", a.auditHandler)
	mux.HandleFunc("/api/backups", a.backupsHandler)
	mux.HandleFunc("/api/backups/", a.backupDownloadHandler)
	mux.HandleFunc("/api/templates", a.templatesHandler)
	mux.HandleFunc("/api/templates/", a.templateHandler)
	mux.HandleFunc("/api/subscriptions", a.subscriptionsHandler)
	mux.HandleFunc("/", a.staticHandler)
	addr := os.Getenv("FLEET_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:18780"
	}
	certFile, keyFile := os.Getenv("FLEET_TLS_CERT"), os.Getenv("FLEET_TLS_KEY")
	if (certFile == "") != (keyFile == "") {
		log.Fatal("set both FLEET_TLS_CERT and FLEET_TLS_KEY")
	}
	if certFile == "" && !loopbackListen(addr) {
		log.Fatal("a public FLEET_LISTEN requires TLS certificate and key")
	}
	server := &http.Server{Addr: addr, Handler: a.auth(mux), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	if certFile != "" {
		log.Printf("fleet manager listening with HTTPS on %s", addr)
		log.Fatal(server.ListenAndServeTLS(certFile, keyFile))
	}
	log.Printf("fleet manager listening with HTTP on %s", addr)
	log.Fatal(server.ListenAndServe())
}

func loopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	return host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
}

func (a *app) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		u, p, ok := r.BasicAuth()
		if !ok || subtle.ConstantTimeCompare([]byte(u), []byte(a.username)) != 1 || subtle.ConstantTimeCompare([]byte(p), []byte(a.password)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="S-UI Fleet Manager"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, e := url.Parse(origin)
				if e != nil || u.Host != r.Host {
					http.Error(w, "invalid origin", http.StatusForbidden)
					return
				}
			}
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				http.Error(w, "JSON required", http.StatusUnsupportedMediaType)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func apiError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decode(r *http.Request, dst any) error {
	defer r.Body.Close()
	d := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func normalizeURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
		return "", errors.New("use a full http(s) panel URL without credentials, query, or fragment")
	}
	return strings.TrimRight(u.String(), "/") + "/", nil
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "localhost" || strings.HasSuffix(host, ".localhost") || host == "0.0.0.0" || net.ParseIP(host).IsLoopback()
}

func (a *app) seal(value string) (string, error) {
	block, err := aes.NewCipher(a.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(value), nil)), nil
}

func (a *app) unseal(value string) (string, error) {
	buf, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(a.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(buf) < gcm.NonceSize() {
		return "", errors.New("bad stored token")
	}
	plain, err := gcm.Open(nil, buf[:gcm.NonceSize()], buf[gcm.NonceSize():], nil)
	return string(plain), err
}

func (a *app) listServers() ([]server, error) {
	rows, err := a.db.Query(`SELECT id,name,region,sui_url,token_cipher,komari_uuid FROM servers ORDER BY region,name,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	servers := []server{}
	for rows.Next() {
		var s server
		if err := rows.Scan(&s.ID, &s.Name, &s.Region, &s.SUIURL, &s.TokenCipher, &s.KomariUUID); err != nil {
			return nil, err
		}
		s.HasToken = s.TokenCipher != ""
		servers = append(servers, s)
	}
	return servers, rows.Err()
}

func (a *app) getServer(id int64) (server, error) {
	var s server
	err := a.db.QueryRow(`SELECT id,name,region,sui_url,token_cipher,komari_uuid FROM servers WHERE id=?`, id).Scan(&s.ID, &s.Name, &s.Region, &s.SUIURL, &s.TokenCipher, &s.KomariUUID)
	s.HasToken = s.TokenCipher != ""
	return s, err
}

func (a *app) serversHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		servers, err := a.listServers()
		if err != nil {
			apiError(w, 500, err)
			return
		}
		writeJSON(w, 200, servers)
	case http.MethodPost:
		var body struct {
			Name       string `json:"name"`
			Region     string `json:"region"`
			SUIURL     string `json:"sui_url"`
			Token      string `json:"token"`
			KomariUUID string `json:"komari_uuid"`
		}
		if err := decode(r, &body); err != nil {
			apiError(w, 400, err)
			return
		}
		body.Name = strings.TrimSpace(body.Name)
		body.Region = strings.TrimSpace(body.Region)
		if body.Name == "" || body.Token == "" {
			apiError(w, 400, errors.New("name and API token are required"))
			return
		}
		if len(body.Name) > 100 || len(body.Region) > 100 || len(body.Token) > 4096 {
			apiError(w, 400, errors.New("field too long"))
			return
		}
		panelURL, err := normalizeURL(body.SUIURL)
		if err != nil {
			apiError(w, 400, err)
			return
		}
		ciphertext, err := a.seal(body.Token)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		res, err := a.db.Exec(`INSERT INTO servers(name,region,sui_url,token_cipher,komari_uuid) VALUES(?,?,?,?,?)`, body.Name, body.Region, panelURL, ciphertext, body.KomariUUID)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		id, _ := res.LastInsertId()
		writeJSON(w, 201, map[string]int64{"id": id})
	default:
		http.Error(w, "method not allowed", 405)
	}
}

func (a *app) serverHandler(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/servers/"), "/"), "/")
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || id <= 0 {
		apiError(w, 400, errors.New("invalid server ID"))
		return
	}
	s, err := a.getServer(id)
	if err != nil {
		apiError(w, 404, errors.New("server not found"))
		return
	}
	if len(parts) == 2 && parts[1] == "detail" && r.Method == http.MethodGet {
		status, se := a.suiGet(r.Context(), s, "status?r=sbd,sys")
		inbounds, ie := a.suiGet(r.Context(), s, "inbounds")
		clients, ce := a.suiGet(r.Context(), s, "clients")
		onlines, oe := a.suiGet(r.Context(), s, "onlines")
		outbounds, be := a.suiGet(r.Context(), s, "outbounds")
		endpoints, ee := a.suiGet(r.Context(), s, "endpoints")
		tls, te := a.suiGet(r.Context(), s, "tls")
		config, fe := a.suiGet(r.Context(), s, "config")
		tlsChoices := []map[string]any{}
		if te == nil {
			for _, item := range objectList(tls, "tls") {
				tlsChoices = append(tlsChoices, map[string]any{"id": item["id"], "tag": item["tag"], "name": item["name"]})
			}
		}
		endpointChoices := []map[string]any{}
		if ee == nil {
			for _, item := range objectList(endpoints, "endpoints") {
				endpointChoices = append(endpointChoices, map[string]any{"tag": item["tag"], "type": item["type"]})
			}
		}
		result := map[string]any{"server": s, "status": status, "inbounds": inbounds, "outbounds": outbounds, "clients": clients, "onlines": onlines, "tls_choices": tlsChoices, "endpoint_choices": endpointChoices}
		if fe == nil {
			_, rules, routeErr := routeConfig(config)
			if routeErr != nil {
				fe = routeErr
			} else {
				result["route_rules"] = rules
			}
		}
		errs := map[string]string{}
		if se != nil {
			errs["status"] = se.Error()
		}
		if ie != nil {
			errs["inbounds"] = ie.Error()
		}
		if ce != nil {
			errs["clients"] = ce.Error()
		}
		if oe != nil {
			errs["onlines"] = oe.Error()
		}
		if be != nil {
			errs["outbounds"] = be.Error()
		}
		if te != nil {
			errs["tls"] = te.Error()
		}
		if ee != nil {
			errs["endpoints"] = ee.Error()
		}
		if fe != nil {
			errs["config"] = fe.Error()
		}
		result["errors"] = errs
		writeJSON(w, 200, result)
		return
	}
	if len(parts) == 2 && parts[1] == "configuration" && r.Method == http.MethodGet {
		a.configurationHandler(w, r, s)
		return
	}
	if len(parts) == 2 && parts[1] == "inbound-options" && r.Method == http.MethodGet {
		data, err := a.suiGet(r.Context(), s, "inbounds")
		if err != nil {
			apiError(w, 502, err)
			return
		}
		options := make([]map[string]any, 0)
		for _, inbound := range objectList(data, "inbounds") {
			options = append(options, map[string]any{"tag": inbound["tag"], "type": inbound["type"], "method": inbound["method"], "listen_port": inbound["listen_port"]})
		}
		writeJSON(w, 200, map[string]any{"inbounds": options})
		return
	}
	if len(parts) != 1 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var body struct {
			Name       string `json:"name"`
			Region     string `json:"region"`
			SUIURL     string `json:"sui_url"`
			Token      string `json:"token"`
			KomariUUID string `json:"komari_uuid"`
		}
		if err := decode(r, &body); err != nil {
			apiError(w, 400, err)
			return
		}
		body.Name = strings.TrimSpace(body.Name)
		if body.Name == "" {
			apiError(w, 400, errors.New("name required"))
			return
		}
		panelURL, err := normalizeURL(body.SUIURL)
		if err != nil {
			apiError(w, 400, err)
			return
		}
		ciphertext := s.TokenCipher
		if body.Token != "" {
			ciphertext, err = a.seal(body.Token)
			if err != nil {
				apiError(w, 500, err)
				return
			}
		}
		_, err = a.db.Exec(`UPDATE servers SET name=?,region=?,sui_url=?,token_cipher=?,komari_uuid=? WHERE id=?`, body.Name, body.Region, panelURL, ciphertext, body.KomariUUID, id)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	case http.MethodDelete:
		_, err := a.db.Exec(`DELETE FROM servers WHERE id=?`, id)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", 405)
	}
}

func (a *app) suiURL(s server, endpoint string) string {
	return strings.TrimRight(s.SUIURL, "/") + "/apiv2/" + endpoint
}

func (a *app) suiRequest(ctx context.Context, s server, method, endpoint string, form url.Values, limit int64) ([]byte, error) {
	token, err := a.unseal(s.TokenCipher)
	if err != nil {
		return nil, errors.New("cannot decrypt panel token")
	}
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, a.suiURL(s, endpoint), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Token", token)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	res, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("S-UI HTTP %d", res.StatusCode)
	}
	buf, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > limit {
		return nil, errors.New("S-UI response too large")
	}
	return buf, nil
}

func (a *app) suiGet(ctx context.Context, s server, endpoint string) (map[string]any, error) {
	buf, err := a.suiRequest(ctx, s, "GET", endpoint, nil, 4<<20)
	if err != nil {
		return nil, err
	}
	var env struct {
		Success bool           `json:"success"`
		Msg     string         `json:"msg"`
		Obj     map[string]any `json:"obj"`
	}
	if err := json.Unmarshal(buf, &env); err != nil {
		return nil, fmt.Errorf("invalid S-UI JSON: %w", err)
	}
	if !env.Success {
		return nil, fmt.Errorf("S-UI: %s", env.Msg)
	}
	return env.Obj, nil
}

func (a *app) suiPost(ctx context.Context, s server, endpoint string, form url.Values) error {
	buf, err := a.suiRequest(ctx, s, "POST", endpoint, form, 4<<20)
	if err != nil {
		return err
	}
	var env struct {
		Success bool   `json:"success"`
		Msg     string `json:"msg"`
	}
	if err := json.Unmarshal(buf, &env); err != nil {
		return fmt.Errorf("invalid S-UI JSON: %w", err)
	}
	if !env.Success {
		return fmt.Errorf("S-UI: %s", env.Msg)
	}
	return nil
}

func isDialFailure(err error) bool {
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}

func (a *app) komariDo(req *http.Request) (*http.Response, error) {
	res, err := a.client.Do(req)
	if err == nil || !isDialFailure(err) {
		return res, err
	}
	host := req.URL.Hostname()
	if host == "" || net.ParseIP(host) != nil || req.GetBody == nil {
		return nil, err
	}

	retry := req.Clone(req.Context())
	retryBody, bodyErr := req.GetBody()
	if bodyErr != nil {
		return nil, err
	}
	retry.Body = retryBody

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, splitErr := net.SplitHostPort(addr)
		if splitErr != nil {
			return nil, splitErr
		}
		dialer := &net.Dialer{Timeout: 5 * time.Second}
		return dialer.DialContext(ctx, "tcp4", net.JoinHostPort(host, port))
	}
	client := &http.Client{
		Timeout:       a.client.Timeout,
		CheckRedirect: a.client.CheckRedirect,
		Transport:     transport,
	}
	res, retryErr := client.Do(retry)
	if retryErr == nil {
		log.Printf("Komari connection used IPv4 fallback for %s", host)
		return res, nil
	}
	return nil, fmt.Errorf("%v; IPv4 fallback failed: %w", err, retryErr)
}

func (a *app) komariRPC(ctx context.Context, method string) (map[string]any, error) {
	return a.komariRPCWithParams(ctx, method, map[string]any{})
}

func (a *app) komariRPCWithParams(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	if a.komariURL == "" {
		return nil, errors.New("KOMARI_URL is not configured")
	}
	buf, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, err := http.NewRequestWithContext(ctx, "POST", a.komariURL+"/api/rpc2", strings.NewReader(string(buf)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if a.komariKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.komariKey)
	}
	res, err := a.komariDo(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("Komari HTTP %d", res.StatusCode)
	}
	var reply struct {
		Result map[string]any `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&reply); err != nil {
		return nil, err
	}
	if reply.Error != nil {
		return nil, errors.New(reply.Error.Message)
	}
	return reply.Result, nil
}

func (a *app) komariNodesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	nodes, err := a.komariRPC(r.Context(), "common:getNodes")
	if err != nil {
		apiError(w, 502, err)
		return
	}
	writeJSON(w, 200, nodes)
}

func (a *app) dashboardHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	servers, err := a.listServers()
	if err != nil {
		apiError(w, 500, err)
		return
	}
	komariStatus, komariErr := a.komariRPC(r.Context(), "common:getNodesLatestStatus")
	komariNodes, nodesErr := a.komariRPC(r.Context(), "common:getNodes")
	if komariErr == nil {
		komariErr = nodesErr
	}
	type row struct {
		Server     server         `json:"server"`
		SUI        map[string]any `json:"sui,omitempty"`
		Komari     map[string]any `json:"komari,omitempty"`
		KomariNode map[string]any `json:"komari_node,omitempty"`
		LatencyMS  int64          `json:"latency_ms,omitempty"`
		Error      string         `json:"error,omitempty"`
	}
	rows := make([]row, len(servers))
	sem := make(chan struct{}, 5)
	var wg sync.WaitGroup
	for i, s := range servers {
		wg.Add(1)
		go func(i int, s server) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			start := time.Now()
			status, err := a.suiGet(r.Context(), s, "status?r=sbd,sys")
			rows[i] = row{Server: s, SUI: status, LatencyMS: time.Since(start).Milliseconds()}
			if err != nil {
				rows[i].Error = err.Error()
			}
			if s.KomariUUID != "" {
				if k, ok := komariStatus[s.KomariUUID].(map[string]any); ok {
					rows[i].Komari = k
				}
				if k, ok := komariNodes[s.KomariUUID].(map[string]any); ok {
					rows[i].KomariNode = k
				}
			}
		}(i, s)
	}
	wg.Wait()
	result := map[string]any{"servers": rows, "monitor_nodes": projectMonitorNodes(komariNodes, komariStatus), "komari_configured": a.komariURL != ""}
	if a.komariPublicURL != "" {
		result["komari_url"] = a.komariPublicURL
	}
	if komariErr != nil && a.komariURL != "" {
		result["komari_error"] = komariErr.Error()
	}
	writeJSON(w, 200, result)
}

func (a *app) staticHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	path := "web" + r.URL.Path
	if r.URL.Path == "/" {
		path = "web/index.html"
	}
	content, err := assets.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(path, ".css") {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	} else if strings.HasSuffix(path, ".js") {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	w.Write(content)
}

func fingerprint(raw json.RawMessage) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func serverFingerprint(s server) string {
	return fingerprint(json.RawMessage(strconv.Quote(s.SUIURL + "\x00" + s.TokenCipher)))
}

func randomID() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func objectList(obj map[string]any, key string) []map[string]any {
	arr, _ := obj[key].([]any)
	result := make([]map[string]any, 0, len(arr))
	for _, x := range arr {
		if m, ok := x.(map[string]any); ok {
			result = append(result, m)
		}
	}
	return result
}

func clientByName(obj map[string]any, name string) (map[string]any, error) {
	var found map[string]any
	for _, c := range objectList(obj, "clients") {
		if c["name"] == name {
			if found != nil {
				return nil, errors.New("duplicate client name on panel")
			}
			found = c
		}
	}
	if found == nil {
		return nil, errors.New("client not found on panel")
	}
	return found, nil
}

func inboundByTag(obj map[string]any, tag string) (map[string]any, error) {
	var found map[string]any
	for _, inbound := range objectList(obj, "inbounds") {
		if inbound["tag"] == tag {
			if found != nil {
				return nil, errors.New("duplicate inbound tag on panel")
			}
			found = inbound
		}
	}
	if found == nil {
		return nil, errors.New("inbound tag not found on panel")
	}
	return found, nil
}

func (a *app) previewHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var req previewRequest
	if err := decode(r, &req); err != nil {
		apiError(w, 400, err)
		return
	}
	if len(req.ServerIDs) == 0 || len(req.ServerIDs) > 50 {
		apiError(w, 400, errors.New("select 1 to 50 servers"))
		return
	}
	switch req.Action {
	case "backup", "restartSb", "client_enable", "client_disable", "client_create", "inbound_patch", "inbound_create", "outbound_create", "outbound_patch", "route_rule_add", "route_rule_replace", "route_rule_delete", "config_save", "rule_set_apply":
	default:
		apiError(w, 400, errors.New("unsupported action"))
		return
	}
	if (req.Action == "client_enable" || req.Action == "client_disable") && req.ClientName == "" {
		apiError(w, 400, errors.New("client name required"))
		return
	}
	var template map[string]any
	var inboundPatch map[string]any
	if req.Action == "inbound_patch" {
		if strings.TrimSpace(req.InboundTag) == "" {
			apiError(w, 400, errors.New("inbound tag required"))
			return
		}
		if err := json.Unmarshal(req.InboundPatch, &inboundPatch); err != nil || (len(inboundPatch) == 0 && req.InboundPublicServer == "" && req.InboundPublicPort == 0) {
			apiError(w, 400, errors.New("nonempty inbound patch JSON object required"))
			return
		}
		if req.InboundPublicPort < 0 || req.InboundPublicPort > 65535 {
			apiError(w, 400, errors.New("invalid public port"))
			return
		}
		for key := range inboundPatch {
			if key == "id" || key == "tag" || key == "type" {
				apiError(w, 400, fmt.Errorf("cannot patch inbound %s", key))
				return
			}
		}
	}
	if req.Action == "client_create" {
		if err := json.Unmarshal(req.Client, &template); err != nil || template == nil {
			apiError(w, 400, errors.New("valid client JSON required"))
			return
		}
		if name, _ := template["name"].(string); name == "" {
			apiError(w, 400, errors.New("client JSON needs name"))
			return
		}
		if _, ok := template["config"].(map[string]any); !ok {
			apiError(w, 400, errors.New("client JSON needs config"))
			return
		}
		delete(template, "id")
		delete(template, "up")
		delete(template, "down")
	}
	if err := validateExtendedRequest(req); err != nil {
		apiError(w, 400, err)
		return
	}
	if req.Action == "config_save" {
		if err := validateConfigRequest(req); err != nil {
			apiError(w, 400, err)
			return
		}
	}
	if req.Action == "rule_set_apply" {
		if err := validateRuleSetApplication(req); err != nil {
			apiError(w, 400, err)
			return
		}
	}
	p := preview{ID: randomID(), Expires: time.Now().Add(5 * time.Minute), Request: req}
	seen := map[int64]bool{}
	ids := []int64{}
	for _, id := range req.ServerIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	p.Changes = make([]change, len(ids))
	sem := make(chan struct{}, 5)
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id int64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			s, err := a.getServer(id)
			if err != nil {
				p.Changes[i] = change{ServerID: id, Error: "server not found"}
				return
			}
			c := change{ServerID: id, ServerName: s.Name, Action: req.Action, ServerFingerprint: serverFingerprint(s)}
			if req.Action == "rule_set_apply" {
				previewRuleSetApplication(r.Context(), a, s, req, &c)
				p.Changes[i] = c
				return
			}
			if req.Action == "config_save" {
				previewConfigSave(r.Context(), a, s, req, &c)
				p.Changes[i] = c
				return
			}
			if isExtendedAction(req.Action) {
				previewExtended(r.Context(), a, s, req, &c)
				p.Changes[i] = c
				return
			}
			if req.Action == "inbound_patch" {
				obj, e := a.suiGet(r.Context(), s, "inbounds")
				if e != nil {
					c.Error = e.Error()
				} else {
					inbound, e := inboundByTag(obj, req.InboundTag)
					if e != nil {
						c.Error = e.Error()
					} else {
						c.Before, _ = json.Marshal(inbound)
						c.Fingerprint = fingerprint(c.Before)
						copyObj := map[string]any{}
						for k, v := range inbound {
							copyObj[k] = v
						}
						for k, v := range inboundPatch {
							copyObj[k] = v
						}
						if req.InboundPublicServer != "" || req.InboundPublicPort != 0 {
							out, _ := inbound["out_json"].(map[string]any)
							if out == nil {
								out = map[string]any{}
							}
							newOut := map[string]any{}
							for k, v := range out {
								newOut[k] = v
							}
							newOut["type"] = inbound["type"]
							if req.InboundPublicServer != "" {
								newOut["server"] = req.InboundPublicServer
							}
							if req.InboundPublicPort != 0 {
								newOut["server_port"] = req.InboundPublicPort
							}
							if newOut["server"] == nil {
								if addresses, ok := inbound["addrs"].([]any); ok && len(addresses) > 0 {
									if first, ok := addresses[0].(map[string]any); ok {
										newOut["server"] = first["server"]
									}
								}
							}
							if server, ok := newOut["server"].(string); !ok || strings.TrimSpace(server) == "" {
								c.Error = "public address required"
							} else {
								port := newOut["server_port"]
								if port == nil {
									port = inbound["listen_port"]
									newOut["server_port"] = port
								}
								copyObj["out_json"] = newOut
								if addresses, ok := inbound["addrs"].([]any); ok && len(addresses) > 0 {
									copyAddresses := append([]any{}, addresses...)
									first, _ := addresses[0].(map[string]any)
									copyFirst := map[string]any{}
									for key, value := range first {
										copyFirst[key] = value
									}
									copyFirst["server"] = server
									copyFirst["server_port"] = port
									copyAddresses[0] = copyFirst
									copyObj["addrs"] = copyAddresses
								}
							}
						}
						c.After, _ = json.Marshal(copyObj)
						if fingerprint(c.After) == c.Fingerprint {
							c.Error = "no fields changed"
						}
					}
				}
			}
			if req.Action == "client_enable" || req.Action == "client_disable" || req.Action == "client_create" {
				obj, e := a.suiGet(r.Context(), s, "clients")
				if e != nil {
					c.Error = e.Error()
				} else {
					if req.Action == "client_create" {
						name := template["name"].(string)
						for _, x := range objectList(obj, "clients") {
							if x["name"] == name {
								c.Error = "client name already exists"
								break
							}
						}
						inbounds := req.InboundsByServer[strconv.FormatInt(id, 10)]
						if len(inbounds) == 0 {
							c.Error = "select inbound IDs for this server"
						} else {
							known, e := a.suiGet(r.Context(), s, "inbounds")
							if e != nil {
								c.Error = e.Error()
							} else {
								available := map[int]bool{}
								for _, inbound := range objectList(known, "inbounds") {
									if id, ok := inbound["id"].(float64); ok {
										available[int(id)] = true
									}
								}
								for _, id := range inbounds {
									if !available[id] {
										c.Error = fmt.Sprintf("inbound ID %d not found", id)
										break
									}
								}
							}
							copyObj := map[string]any{}
							for k, v := range template {
								copyObj[k] = v
							}
							copyObj["inbounds"] = inbounds
							if c.Error == "" {
								c.After, _ = json.Marshal(copyObj)
							}
						}
					} else {
						client, e := clientByName(obj, req.ClientName)
						if e != nil {
							c.Error = e.Error()
						} else {
							c.Before, _ = json.Marshal(client)
							c.Fingerprint = fingerprint(c.Before)
							copyObj := map[string]any{}
							for k, v := range client {
								copyObj[k] = v
							}
							copyObj["enable"] = req.Action == "client_enable"
							c.After, _ = json.Marshal(copyObj)
							if client["enable"] == copyObj["enable"] {
								c.Error = "already in requested state"
							}
						}
					}
				}
			}
			p.Changes[i] = c
		}(i, id)
	}
	wg.Wait()
	a.mu.Lock()
	for id, old := range a.previews {
		if time.Now().After(old.Expires) {
			delete(a.previews, id)
		}
	}
	a.previews[p.ID] = p
	a.mu.Unlock()
	writeJSON(w, 200, p)
}

func (a *app) executeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		PreviewID string `json:"preview_id"`
	}
	if err := decode(r, &input); err != nil {
		apiError(w, http.StatusBadRequest, err)
		return
	}
	a.mu.Lock()
	p, ok := a.previews[input.PreviewID]
	if ok {
		delete(a.previews, input.PreviewID)
	}
	a.mu.Unlock()
	if !ok || time.Now().After(p.Expires) {
		apiError(w, http.StatusBadRequest, errors.New("preview expired or already used"))
		return
	}

	if len(p.Changes) > 1 {
		job, err := a.createJob(p)
		if err != nil {
			apiError(w, http.StatusInternalServerError, err)
			return
		}
		go a.runJob(p, job.ID)
		writeJSON(w, http.StatusAccepted, job)
		return
	}

	results := make([]outcome, 0, len(p.Changes))
	for _, c := range p.Changes {
		results = append(results, a.executeChange(r.Context(), p, c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (a *app) verifySaved(ctx context.Context, s server, c change, req previewRequest) error {
	endpoint := "clients"
	if c.Action == "inbound_patch" {
		endpoint = "inbounds"
	}
	obj, err := a.suiGet(ctx, s, endpoint)
	if err != nil {
		return fmt.Errorf("save accepted, verification unavailable: %w", err)
	}
	if c.Action == "inbound_patch" {
		actual, err := inboundByTag(obj, req.InboundTag)
		if err != nil {
			return fmt.Errorf("save accepted, verification failed: %w", err)
		}
		var patch map[string]any
		_ = json.Unmarshal(req.InboundPatch, &patch)
		for key, value := range patch {
			if !reflect.DeepEqual(actual[key], value) {
				return fmt.Errorf("save accepted, inbound field %s did not match", key)
			}
		}
		return nil
	}
	name := req.ClientName
	if c.Action == "client_create" {
		var target map[string]any
		_ = json.Unmarshal(c.After, &target)
		name, _ = target["name"].(string)
	}
	actual, err := clientByName(obj, name)
	if err != nil {
		return fmt.Errorf("save accepted, verification failed: %w", err)
	}
	if c.Action == "client_enable" && actual["enable"] != true {
		return errors.New("save accepted, client is still disabled")
	}
	if c.Action == "client_disable" && actual["enable"] != false {
		return errors.New("save accepted, client is still enabled")
	}
	return nil
}

func (a *app) backup(ctx context.Context, s server) (string, error) {
	buf, err := a.suiRequest(ctx, s, "GET", "getdb?exclude=stats,changes", nil, 100<<20)
	if err != nil {
		return "", err
	}
	if len(buf) < 16 || string(buf[:16]) != "SQLite format 3\x00" {
		return "", errors.New("S-UI backup is not a SQLite database")
	}
	dir := filepath.Join(a.dataDir, "backups")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	_ = os.Chmod(dir, 0700)
	name := fmt.Sprintf("sui-%d-%s-%s.db", s.ID, time.Now().UTC().Format("20060102T150405Z"), randomID()[:8])
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, buf, 0600); err != nil {
		return "", err
	}
	return name, nil
}

func (a *app) backupsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	dir := filepath.Join(a.dataDir, "backups")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, 200, []any{})
		return
	}
	if err != nil {
		apiError(w, 500, err)
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() > entries[j].Name() })
	items := []map[string]any{}
	for _, entry := range entries {
		if entry.IsDir() || !validBackupName(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, map[string]any{"name": entry.Name(), "size": info.Size(), "created": info.ModTime().UTC().Format(time.RFC3339)})
		if len(items) == 100 {
			break
		}
	}
	writeJSON(w, 200, items)
}

func validBackupName(name string) bool {
	if !strings.HasPrefix(name, "sui-") || !strings.HasSuffix(name, ".db") || filepath.Base(name) != name {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '.' || r == '_') {
			return false
		}
	}
	return true
}

func (a *app) backupDownloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/api/backups/")
	if !validBackupName(name) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, filepath.Join(a.dataDir, "backups", name))
}

func (a *app) auditHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	rows, err := a.db.Query(`SELECT at,action,server_id,ok,detail FROM audit ORDER BY id DESC LIMIT 100`)
	if err != nil {
		apiError(w, 500, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var at, action, detail string
		var id, ok int64
		if err := rows.Scan(&at, &action, &id, &ok, &detail); err != nil {
			apiError(w, 500, err)
			return
		}
		items = append(items, map[string]any{"at": at, "action": action, "server_id": id, "ok": ok == 1, "detail": detail})
	}
	writeJSON(w, 200, items)
}
