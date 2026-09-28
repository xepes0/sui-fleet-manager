package main

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
)

type subscriptionRow struct {
	Name     string `json:"name"`
	Remark   string `json:"remark"`
	Enabled  bool   `json:"enabled"`
	Used     int64  `json:"used"`
	Limit    int64  `json:"limit"`
	Expiry   int64  `json:"expiry"`
	PlainURL string `json:"plain_url,omitempty"`
	JSONURL  string `json:"json_url,omitempty"`
	ClashURL string `json:"clash_url,omitempty"`
}

func publicSubscriptionBase(settings map[string]any, panelURL string) (string, error) {
	if raw := stringValue(settings, "subURI"); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return "", errors.New("S-UI subURI must be a public HTTPS base URL")
		}
		if isLoopbackHost(u.Hostname()) || isPrivateSubscriptionIP(u.Hostname()) {
			return "", errors.New("S-UI subURI points to a private address")
		}
		return strings.TrimRight(u.String(), "/") + "/", nil
	}
	panel, err := url.Parse(panelURL)
	if err != nil {
		return "", err
	}
	host := stringValue(settings, "subDomain")
	if host == "" {
		host = panel.Hostname()
	}
	if host == "" || isLoopbackHost(host) || isPrivateSubscriptionIP(host) {
		return "", errors.New("set a public S-UI subscription domain or subURI")
	}
	port := int64Value(settings["subPort"])
	if port < 1 || port > 65535 {
		port = 2096
	}
	scheme := "http"
	if stringValue(settings, "subCertFile") != "" && stringValue(settings, "subKeyFile") != "" {
		scheme = "https"
	}
	if scheme != "https" {
		return "", errors.New("S-UI subscription endpoint needs HTTPS certificates or a public HTTPS subURI")
	}
	prefix := stringValue(settings, "subPath")
	if prefix == "" {
		prefix = "/sub/"
	}
	u := &url.URL{Scheme: scheme, Host: net.JoinHostPort(host, strconv.FormatInt(port, 10)), Path: path.Clean("/"+prefix) + "/"}
	return u.String(), nil
}

func isPrivateSubscriptionIP(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified())
}

func int64Value(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case string:
		parsed, _ := strconv.ParseInt(n, 10, 64)
		return parsed
	}
	return 0
}

func (a *app) subscriptionsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		apiError(w, 405, errors.New("method not allowed"))
		return
	}
	id, err := strconv.ParseInt(r.URL.Query().Get("server_id"), 10, 64)
	if err != nil || id < 1 {
		apiError(w, 400, errors.New("select a server"))
		return
	}
	s, err := a.getServer(id)
	if err != nil {
		apiError(w, 404, errors.New("server not found"))
		return
	}
	clientsData, err := a.suiGet(r.Context(), s, "clients")
	if err != nil {
		apiError(w, 502, err)
		return
	}
	settingsData, err := a.suiGet(r.Context(), s, "settings")
	if err != nil {
		apiError(w, 502, err)
		return
	}
	settings, _ := configCategory(settingsData, "settings").(map[string]any)
	base, baseErr := publicSubscriptionBase(settings, s.SUIURL)
	rows := []subscriptionRow{}
	for _, client := range objectList(clientsData, "clients") {
		name := stringValue(client, "name")
		if name == "" {
			continue
		}
		row := subscriptionRow{Name: name, Remark: stringValue(client, "remark"), Enabled: client["enable"] == true, Used: int64Value(client["up"]) + int64Value(client["down"]), Limit: int64Value(client["volume"]), Expiry: int64Value(client["expiry"])}
		if baseErr == nil {
			row.PlainURL = base + url.PathEscape(name)
			row.JSONURL = row.PlainURL + "?format=json"
			row.ClashURL = row.PlainURL + "?format=clash"
		}
		rows = append(rows, row)
	}
	response := map[string]any{
		"server":   s.Name,
		"clients":  rows,
		"base_url": base,
		"settings": map[string]string{"subURI": stringValue(settings, "subURI")},
		"warning":  "S-UI uses the client name as the subscription identifier; anyone who knows an active URL can retrieve that client's node configuration.",
	}
	if baseErr != nil {
		response["base_error"] = baseErr.Error()
	}
	writeJSON(w, 200, response)
}
