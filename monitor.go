package main

import (
	"net/http"
	"sort"
)

var monitorInfoFields = []string{"name", "region", "group", "cpu_name", "os", "mem_total", "disk_total", "price", "billing_cycle", "currency", "expired_at", "traffic_limit", "traffic_limit_type", "weight"}
var monitorStatusFields = []string{"online", "time", "cpu", "ram", "ram_total", "disk", "disk_total", "load", "net_in", "net_out", "net_total_up", "net_total_down", "connections", "connections_udp", "uptime", "ping"}

func projectMonitorNodes(nodes, status map[string]any) []map[string]any {
	result := make([]map[string]any, 0, len(nodes))
	for uuid, raw := range nodes {
		info, ok := raw.(map[string]any)
		if !ok || info["hidden"] == true {
			continue
		}
		item := map[string]any{"uuid": uuid}
		for _, key := range monitorInfoFields {
			if val, ok := info[key]; ok {
				item[key] = val
			}
		}
		if live, ok := status[uuid].(map[string]any); ok {
			clean := make(map[string]any)
			for _, key := range monitorStatusFields {
				if val, ok := live[key]; ok {
					clean[key] = val
				}
			}
			item["status"] = clean
		}
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool {
		left, _ := result[i]["name"].(string)
		right, _ := result[j]["name"].(string)
		return left < right
	})
	return result
}

func (a *app) komariPingHistoryHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	nodes, err := a.komariRPC(r.Context(), "common:getNodes")
	if err != nil {
		apiError(w, http.StatusBadGateway, err)
		return
	}
	ids := make([]string, 0, len(nodes))
	for uuid, raw := range nodes {
		if info, ok := raw.(map[string]any); ok && info["hidden"] != true {
			ids = append(ids, uuid)
		}
	}
	if len(ids) == 0 {
		writeJSON(w, 200, map[string]any{"series": []any{}})
		return
	}
	sort.Strings(ids)
	data, err := a.komariRPCWithParams(r.Context(), "public:queryMetrics", map[string]any{
		"metric_key": "ping.latency_ms", "entity_ids": ids, "hours": 1, "max_points": 20, "aggregation": "avg",
	})
	if err != nil {
		apiError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, 200, map[string]any{"series": data["series"]})
}
