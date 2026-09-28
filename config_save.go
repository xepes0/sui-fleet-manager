package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
)

var configTargets = []string{"clients", "inbounds", "outbounds", "endpoints", "services", "tls", "config", "settings"}

func configCategory(data map[string]any, target string) any {
	if value := data[target]; value != nil {
		return value
	}
	if target == "settings" {
		return data
	}
	return nil
}

type configPatchOp struct {
	Op    string          `json:"op"`
	Path  []any           `json:"path"`
	Value json.RawMessage `json:"value,omitempty"`
}

func allowedConfigTarget(target string) bool {
	for _, item := range configTargets {
		if target == item {
			return true
		}
	}
	return false
}

func (a *app) configurationHandler(w http.ResponseWriter, r *http.Request, s server) {
	result := make(map[string]any, len(configTargets)+1)
	errs := map[string]string{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, target := range configTargets {
		wg.Add(1)
		go func(target string) {
			defer wg.Done()
			data, err := a.suiGet(r.Context(), s, target)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs[target] = err.Error()
			} else {
				value := configCategory(data, target)
				if value == nil && target != "config" && target != "settings" {
					value = []any{}
				}
				result[target] = value
			}
		}(target)
	}
	wg.Wait()
	result["errors"] = errs
	writeJSON(w, 200, result)
}

func configPayload(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || len(raw) > 900<<10 {
		return nil, errors.New("config object must be between 1 byte and 900 KiB")
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, errors.New("config data must be a JSON object")
	}
	return value, nil
}

func validateConfigPatch(req previewRequest) error {
	if (len(req.ConfigPatch) == 0 && !(req.ConfigTarget == "inbounds" && len(req.ConfigPublicAddrs) > 0)) || len(req.ConfigPatch) > 100 {
		return errors.New("select 1 to 100 fields to change")
	}
	if req.ConfigTarget != "config" {
		prefix := configNameKey(req.ConfigTarget) + ":"
		if len(req.ServerIDs) > 1 && (!strings.HasPrefix(req.ConfigIdentity, prefix) || strings.TrimPrefix(req.ConfigIdentity, prefix) == "") {
			return fmt.Errorf("batch object identity must use %s", prefix)
		}
	}
	for _, op := range req.ConfigPatch {
		if op.Op != "set" && op.Op != "remove" {
			return errors.New("field operation must be set or remove")
		}
		if len(op.Path) == 0 || len(op.Path) > 16 {
			return errors.New("field path must contain 1 to 16 segments")
		}
		for i, part := range op.Path {
			switch value := part.(type) {
			case string:
				if value == "" || value == "__proto__" || value == "prototype" || value == "constructor" {
					return errors.New("invalid field path")
				}
				if i == 0 && req.ConfigTarget != "config" {
					if value == "id" || (value == configNameKey(req.ConfigTarget) && (value != "tag" || len(op.Path) != 1 || op.Op != "set")) {
						return errors.New("batch changes cannot alter this object identifier")
					}
				}
			case float64:
				if value < 0 || value > 10000 || value != float64(int(value)) {
					return errors.New("invalid list index")
				}
			default:
				return errors.New("field path must use names or list indices")
			}
		}
		if op.Op == "set" {
			if len(op.Value) == 0 || len(op.Value) > 256<<10 || !json.Valid(op.Value) {
				return errors.New("set field requires a valid value")
			}
			if req.ConfigTarget != "config" && len(op.Path) == 1 && op.Path[0] == "tag" {
				var tag string
				if err := json.Unmarshal(op.Value, &tag); err != nil || tag == "" || tag != strings.TrimSpace(tag) {
					return errors.New("new Tag must be nonempty text without surrounding spaces")
				}
			}
		}
	}
	return nil
}

func applyConfigPatch(original map[string]any, ops []configPatchOp) (map[string]any, error) {
	var result map[string]any
	if err := json.Unmarshal(mustJSON(original), &result); err != nil {
		return nil, err
	}
	for _, op := range ops {
		var current any = result
		for _, part := range op.Path[:len(op.Path)-1] {
			switch container := current.(type) {
			case map[string]any:
				name, ok := part.(string)
				if !ok {
					return nil, errors.New("field path does not match object")
				}
				current, ok = container[name]
				if !ok {
					return nil, fmt.Errorf("field %s is missing on this server", name)
				}
			case []any:
				number, ok := part.(float64)
				if !ok || int(number) >= len(container) {
					return nil, errors.New("list index is missing on this server")
				}
				current = container[int(number)]
			default:
				return nil, errors.New("field parent is not an object or list")
			}
		}
		last := op.Path[len(op.Path)-1]
		var value any
		if op.Op == "set" {
			if err := json.Unmarshal(op.Value, &value); err != nil {
				return nil, err
			}
		}
		switch container := current.(type) {
		case map[string]any:
			name, ok := last.(string)
			if !ok {
				return nil, errors.New("field path does not match object")
			}
			if op.Op == "remove" {
				if _, exists := container[name]; !exists {
					return nil, fmt.Errorf("field %s is missing on this server", name)
				}
				delete(container, name)
			} else {
				container[name] = value
			}
		case []any:
			number, ok := last.(float64)
			if !ok || int(number) >= len(container) {
				return nil, errors.New("list index is missing on this server")
			}
			if op.Op == "remove" {
				return nil, errors.New("batch list deletion is not supported; edit the list on each server")
			}
			container[int(number)] = value
		default:
			return nil, errors.New("field parent is not an object or list")
		}
	}
	return result, nil
}

func validateConfigRequest(req previewRequest) error {
	if len(req.ServerIDs) != 1 && req.ConfigMode != "patch" && req.ConfigMode != "new" && req.ConfigMode != "del" && !(req.ConfigTarget == "settings" && req.ConfigMode == "set") {
		return errors.New("complete object replacement works on exactly one server; choose fields for batch changes")
	}
	if !allowedConfigTarget(req.ConfigTarget) {
		return errors.New("unsupported S-UI configuration category")
	}
	if req.ConfigInboundTags != nil {
		if req.ConfigTarget != "clients" || (req.ConfigMode != "new" && req.ConfigMode != "patch") || len(req.ConfigInboundTags) > 100 {
			return errors.New("inbound Tag selection is only supported for client creation or patch")
		}
		seen := map[string]bool{}
		for _, tag := range req.ConfigInboundTags {
			if strings.TrimSpace(tag) == "" || seen[tag] {
				return errors.New("inbound Tags must be nonempty and unique")
			}
			seen[tag] = true
		}
	}
	if req.ConfigInboundsByServer != nil {
		if req.ConfigInboundTags != nil || req.ConfigTarget != "clients" || (req.ConfigMode != "new" && req.ConfigMode != "patch") || len(req.ConfigInboundsByServer) != len(req.ServerIDs) {
			return errors.New("per-server inbound selection must cover all target clients")
		}
		for _, id := range req.ServerIDs {
			tags, ok := req.ConfigInboundsByServer[strconv.FormatInt(id, 10)]
			if !ok || len(tags) == 0 || len(tags) > 100 {
				return fmt.Errorf("select 1 to 100 inbounds for server %d", id)
			}
			seen := map[string]bool{}
			for _, tag := range tags {
				if strings.TrimSpace(tag) == "" || seen[tag] {
					return errors.New("per-server inbound Tags must be nonempty and unique")
				}
				seen[tag] = true
			}
		}
	}
	if req.ConfigTLSName != "" && (req.ConfigTarget != "inbounds" || (req.ConfigMode != "new" && req.ConfigMode != "patch")) {
		return errors.New("TLS name selection is only supported for inbound creation or patch")
	}
	if len(req.ConfigPublicAddrs) > 0 && (req.ConfigTarget != "inbounds" || (req.ConfigMode != "new" && req.ConfigMode != "patch")) {
		return errors.New("public addresses are only supported for inbound creation or patch")
	}
	if req.ConfigSourceTag != "" && (req.ConfigTarget != "inbounds" || req.ConfigMode != "new") {
		return errors.New("copy source is only supported for new inbounds")
	}
	if req.ConfigMode == "new" && len(req.ConfigPatch) > 0 {
		if req.ConfigTarget != "inbounds" || req.ConfigSourceTag == "" {
			return errors.New("new-object field changes require a copied inbound")
		}
		copyRequest := req
		copyRequest.ConfigIdentity = "tag:" + req.ConfigSourceTag
		if err := validateConfigPatch(copyRequest); err != nil {
			return err
		}
		reserved := map[string]bool{"id": true, "tag": true, "type": true, "listen": true, "listen_port": true, "tls_id": true, "addrs": true, "out_json": true}
		for _, op := range req.ConfigPatch {
			if key, ok := op.Path[0].(string); !ok || reserved[key] {
				return errors.New("copied inbound field changes cannot alter managed fields")
			}
		}
	}
	for _, addr := range req.ConfigPublicAddrs {
		if addr.Server != "" && (addr.Port < 1 || addr.Port > 65535) {
			return errors.New("public address port must be between 1 and 65535")
		}
	}
	if req.ConfigTarget == "config" || req.ConfigTarget == "settings" {
		if req.ConfigMode != "set" && !(req.ConfigTarget == "config" && req.ConfigMode == "patch") {
			return errors.New("config and settings use set or patch mode")
		}
	} else if req.ConfigMode != "new" && req.ConfigMode != "edit" && req.ConfigMode != "del" && req.ConfigMode != "patch" {
		return errors.New("object mode must be new, edit, patch or del")
	}
	if (req.ConfigMode == "edit" || req.ConfigMode == "del" || (req.ConfigMode == "patch" && req.ConfigTarget != "config")) && strings.TrimSpace(req.ConfigIdentity) == "" {
		return errors.New("existing object ID required")
	}
	if len(req.ServerIDs) > 1 && req.ConfigMode == "del" {
		prefix := configNameKey(req.ConfigTarget) + ":"
		if !strings.HasPrefix(req.ConfigIdentity, prefix) || strings.TrimPrefix(req.ConfigIdentity, prefix) == "" {
			return fmt.Errorf("batch deletion must identify objects by %s", prefix)
		}
	}
	if req.ConfigMode == "patch" {
		return validateConfigPatch(req)
	}
	if req.ConfigMode == "del" {
		return nil
	}
	value, err := configPayload(req.Object)
	if err != nil {
		return err
	}
	if req.ConfigTarget == "settings" {
		if len(value) == 0 {
			return errors.New("choose at least one setting to change")
		}
		for key, item := range value {
			if _, ok := item.(string); !ok {
				return fmt.Errorf("setting %s must be a string", key)
			}
			if key == "config" || key == "version" || key == "globalResetLast" || key == "maintenance" {
				return fmt.Errorf("setting %s is managed through another S-UI control", key)
			}
		}
		return nil
	}
	if req.ConfigTarget == "config" {
		if len(value) == 0 {
			return errors.New("core configuration cannot be empty")
		}
		return nil
	}
	if req.ConfigMode == "new" {
		if _, ok := value["id"]; ok {
			return errors.New("omit id when creating an object")
		}
	}
	key := "tag"
	if req.ConfigTarget == "clients" || req.ConfigTarget == "tls" {
		key = "name"
	}
	if strings.TrimSpace(stringField(value, key)) == "" {
		return fmt.Errorf("%s required", key)
	}
	if req.ConfigTarget != "clients" && req.ConfigTarget != "tls" && strings.TrimSpace(stringField(value, "type")) == "" {
		return errors.New("type required")
	}
	return nil
}

func resolveConfigInboundTags(ctx context.Context, a *app, s server, tags []string) ([]int, error) {
	if len(tags) == 0 {
		return []int{}, nil
	}
	data, err := a.suiGet(ctx, s, "inbounds")
	if err != nil {
		return nil, err
	}
	available := map[string]int{}
	for _, item := range objectList(data, "inbounds") {
		tag, ok := item["tag"].(string)
		id, idOK := item["id"].(float64)
		if !ok || !idOK || id < 1 || id != float64(int(id)) {
			continue
		}
		if _, duplicate := available[tag]; duplicate {
			return nil, fmt.Errorf("duplicate inbound Tag %q on S-UI", tag)
		}
		available[tag] = int(id)
	}
	ids := make([]int, 0, len(tags))
	for _, tag := range tags {
		id, ok := available[tag]
		if !ok {
			return nil, fmt.Errorf("inbound Tag %q is missing on this server", tag)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func resolveConfigTLSName(ctx context.Context, a *app, s server, name string) (int, error) {
	if name == "none" {
		return 0, nil
	}
	data, err := a.suiGet(ctx, s, "tls")
	if err != nil {
		return 0, err
	}
	var id int
	for _, item := range objectList(data, "tls") {
		if item["name"] != name {
			continue
		}
		rawID, ok := item["id"].(float64)
		if !ok || rawID < 1 || rawID != float64(int(rawID)) {
			return 0, fmt.Errorf("TLS %q has no valid ID", name)
		}
		if id != 0 {
			return 0, fmt.Errorf("duplicate TLS name %q on S-UI", name)
		}
		id = int(rawID)
	}
	if id == 0 {
		return 0, fmt.Errorf("TLS %q is missing on this server", name)
	}
	return id, nil
}

func applyConfigPublicAddress(template map[string]any, addr configPublicAddr) {
	if addr.Server == "" {
		template["addrs"] = []any{}
		template["out_json"] = map[string]any{}
		return
	}
	addrs, _ := template["addrs"].([]any)
	if len(addrs) == 0 {
		addrs = []any{map[string]any{}}
	}
	first, ok := addrs[0].(map[string]any)
	if !ok {
		first = map[string]any{}
	}
	first["server"] = addr.Server
	first["server_port"] = addr.Port
	addrs[0] = first
	template["addrs"] = addrs
	out, _ := template["out_json"].(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	out["type"] = template["type"]
	out["server"] = addr.Server
	out["server_port"] = addr.Port
	template["out_json"] = out
}

func configIdentity(item map[string]any) string {
	if id, ok := item["id"].(float64); ok {
		return fmt.Sprintf("%.0f", id)
	}
	return ""
}

func configItem(list []map[string]any, identity string) (map[string]any, error) {
	var found map[string]any
	for _, item := range list {
		matches := configIdentity(item) == identity
		if strings.HasPrefix(identity, "tag:") {
			matches = stringField(item, "tag") == strings.TrimPrefix(identity, "tag:")
		}
		if strings.HasPrefix(identity, "name:") {
			matches = stringField(item, "name") == strings.TrimPrefix(identity, "name:")
		}
		if matches {
			if found != nil {
				return nil, errors.New("duplicate object ID returned by S-UI")
			}
			found = item
		}
	}
	if found == nil {
		return nil, errors.New("object no longer exists on S-UI")
	}
	return found, nil
}

func configNameKey(target string) string {
	if target == "clients" || target == "tls" {
		return "name"
	}
	return "tag"
}

func normalizeNewClientTemplate(template map[string]any) error {
	if template == nil {
		return errors.New("client data is required")
	}
	if _, ok := template["links"]; !ok {
		template["links"] = []any{}
	} else if _, ok := template["links"].([]any); !ok {
		return errors.New("client links must be a JSON array")
	}
	if _, ok := template["config"].(map[string]any); !ok {
		return errors.New("client config must be a JSON object")
	}
	if _, ok := template["inbounds"].([]any); !ok {
		return errors.New("client inbounds must be a JSON array")
	}
	return nil
}


func collectTagReferences(value any, tag, path string, refs *[]string) {
	if len(*refs) >= 4 {
		return
	}
	switch item := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(item))
		for key := range item {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			collectTagReferences(item[key], tag, path+"."+key, refs)
		}
	case []any:
		for index, child := range item {
			collectTagReferences(child, tag, fmt.Sprintf("%s[%d]", path, index), refs)
		}
	case string:
		if item == tag {
			*refs = append(*refs, path)
		}
	}
}

func configTagReferences(ctx context.Context, a *app, s server, target string, item map[string]any, tag string) ([]string, error) {
	var refs []string
	self := cloneMap(item)
	delete(self, "tag")
	collectTagReferences(self, tag, target+"[self]", &refs)
	for _, category := range []string{"config", "inbounds", "outbounds", "endpoints", "services"} {
		data, err := a.suiGet(ctx, s, category)
		if err != nil {
			return nil, fmt.Errorf("cannot inspect %s references: %w", category, err)
		}
		if category == "config" {
			collectTagReferences(configCategory(data, category), tag, category, &refs)
			continue
		}
		for index, other := range objectList(data, category) {
			if category == target && reflect.DeepEqual(other["id"], item["id"]) {
				continue
			}
			collectTagReferences(other, tag, fmt.Sprintf("%s[%d]", category, index), &refs)
		}
	}
	return refs, nil
}

func previewConfigSave(ctx context.Context, a *app, s server, req previewRequest, c *change) {
	data, err := a.suiGet(ctx, s, req.ConfigTarget)
	if err != nil {
		c.Error = err.Error()
		return
	}
	current := configCategory(data, req.ConfigTarget)
	if current == nil {
		if req.ConfigTarget == "config" || req.ConfigTarget == "settings" {
			c.Error = "S-UI returned an empty configuration category"
			return
		}
		current = []any{}
	}
	if req.ConfigTarget == "config" || req.ConfigTarget == "settings" {
		original, ok := current.(map[string]any)
		if !ok {
			c.Error = "S-UI returned an invalid configuration object"
			return
		}
		var changeObject map[string]any
		if req.ConfigMode != "patch" {
			changeObject, _ = configPayload(req.Object)
		}
		c.Before, _ = json.Marshal(original)
		c.Fingerprint = fingerprint(c.Before)
		if req.ConfigTarget == "settings" {
			merged := cloneMap(original)
			for key, value := range changeObject {
				if _, exists := original[key]; !exists {
					c.Error = fmt.Sprintf("unknown S-UI setting: %s", key)
					return
				}
				merged[key] = value
			}
			c.After, _ = json.Marshal(merged)
		} else if req.ConfigMode == "patch" {
			patched, err := applyConfigPatch(original, req.ConfigPatch)
			if err != nil {
				c.Error = err.Error()
				return
			}
			c.After, _ = json.Marshal(patched)
		} else {
			c.After, _ = json.Marshal(changeObject)
		}
		if fingerprint(c.After) == c.Fingerprint {
			c.Error = "no configuration fields changed"
		}
		return
	}
	list := objectList(data, req.ConfigTarget)
	if req.ConfigMode == "new" {
		template, _ := configPayload(req.Object)
		if req.ConfigTarget == "clients" {
			if err := normalizeNewClientTemplate(template); err != nil {
				c.Error = err.Error()
				return
			}
		}
		if req.ConfigTarget == "inbounds" && req.ConfigSourceTag != "" {
			var source map[string]any
			for _, item := range list {
				if item["tag"] == req.ConfigSourceTag {
					source = item
					break
				}
			}
			if source == nil {
				c.Error = fmt.Sprintf("source inbound Tag %q is missing on this server", req.ConfigSourceTag)
				return
			}
			if source["type"] != template["type"] {
				c.Error = fmt.Sprintf("source inbound Tag %q uses a different protocol on this server", req.ConfigSourceTag)
				return
			}
			copyObject := cloneMap(source)
			delete(copyObject, "id")
			for _, key := range []string{"tag", "listen", "listen_port"} {
				if value, ok := template[key]; ok {
					copyObject[key] = value
				}
			}
			if reflect.DeepEqual(copyObject["listen"], source["listen"]) && reflect.DeepEqual(copyObject["listen_port"], source["listen_port"]) {
				c.Error = "copied inbound must use a different listen address or port"
				return
			}
			if len(req.ConfigPatch) > 0 {
				copyObject, err = applyConfigPatch(copyObject, req.ConfigPatch)
				if err != nil {
					c.Error = err.Error()
					return
				}
			}
			template = copyObject
		}
		if req.ConfigTarget == "clients" && (req.ConfigInboundTags != nil || req.ConfigInboundsByServer != nil) {
			tags := req.ConfigInboundTags
			if req.ConfigInboundsByServer != nil {
				tags = req.ConfigInboundsByServer[strconv.FormatInt(s.ID, 10)]
			}
			ids, err := resolveConfigInboundTags(ctx, a, s, tags)
			if err != nil {
				c.Error = err.Error()
				return
			}
			template["inbounds"] = ids
		}
		if req.ConfigTarget == "inbounds" {
			if req.ConfigTLSName != "" {
				id, err := resolveConfigTLSName(ctx, a, s, req.ConfigTLSName)
				if err != nil {
					c.Error = err.Error()
					return
				}
				template["tls_id"] = id
			}
			if addr, ok := req.ConfigPublicAddrs[fmt.Sprint(s.ID)]; ok {
				applyConfigPublicAddress(template, addr)
			}
			for _, existing := range list {
				if reflect.DeepEqual(existing["listen"], template["listen"]) && reflect.DeepEqual(existing["listen_port"], template["listen_port"]) {
					c.Error = fmt.Sprintf("listen address and port already used by inbound %q", stringField(existing, "tag"))
					return
				}
			}
		}
		key := configNameKey(req.ConfigTarget)
		for _, item := range list {
			if item[key] == template[key] {
				c.Error = fmt.Sprintf("%s already exists", key)
				return
			}
		}
		c.Fingerprint = fingerprint(mustJSON(current))
		c.After, _ = json.Marshal(template)
		return
	}
	item, err := configItem(list, req.ConfigIdentity)
	if err != nil {
		c.Error = err.Error()
		return
	}
	c.Before, _ = json.Marshal(item)
	c.Fingerprint = fingerprint(c.Before)
	if req.ConfigMode == "del" {
		return
	}
	var template map[string]any
	if req.ConfigMode == "patch" {
		patch := append([]configPatchOp(nil), req.ConfigPatch...)
		if req.ConfigTarget == "clients" && (req.ConfigInboundTags != nil || req.ConfigInboundsByServer != nil) {
			tags := req.ConfigInboundTags
			if req.ConfigInboundsByServer != nil {
				tags = req.ConfigInboundsByServer[strconv.FormatInt(s.ID, 10)]
			}
			ids, resolveErr := resolveConfigInboundTags(ctx, a, s, tags)
			if resolveErr != nil {
				c.Error = resolveErr.Error()
				return
			}
			patch = append(patch, configPatchOp{Op: "set", Path: []any{"inbounds"}, Value: mustJSON(ids)})
		}
		if req.ConfigTarget == "inbounds" && req.ConfigTLSName != "" {
			id, resolveErr := resolveConfigTLSName(ctx, a, s, req.ConfigTLSName)
			if resolveErr != nil {
				c.Error = resolveErr.Error()
				return
			}
			patch = append(patch, configPatchOp{Op: "set", Path: []any{"tls_id"}, Value: mustJSON(id)})
		}
		template, err = applyConfigPatch(item, patch)
		if err != nil {
			c.Error = err.Error()
			return
		}
	} else {
		template, _ = configPayload(req.Object)
	}
	if req.ConfigTarget == "inbounds" && req.ConfigMode == "patch" {
		if addr, ok := req.ConfigPublicAddrs[fmt.Sprint(s.ID)]; ok {
			applyConfigPublicAddress(template, addr)
		}
	}
	if !reflect.DeepEqual(template["id"], item["id"]) {
		c.Error = "object ID cannot be changed"
		return
	}
	key := configNameKey(req.ConfigTarget)
	for _, other := range list {
		if configIdentity(other) != configIdentity(item) && other[key] == template[key] {
			c.Error = fmt.Sprintf("%s already exists", key)
			return
		}
	}
	if key == "tag" && stringField(item, "tag") != stringField(template, "tag") {
		refs, err := configTagReferences(ctx, a, s, req.ConfigTarget, item, stringField(item, "tag"))
		if err != nil {
			c.Error = err.Error()
			return
		}
		if len(refs) > 0 {
			c.Error = fmt.Sprintf("Tag %q 仍被 %s 引用，请先修改这些引用", stringField(item, "tag"), strings.Join(refs, "、"))
			return
		}
	}
	c.After, _ = json.Marshal(template)
	if fingerprint(c.After) == c.Fingerprint {
		c.Error = "no configuration fields changed"
	}
}

func mustJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

func executeConfigSave(ctx context.Context, a *app, s server, c change, req previewRequest) (string, error) {
	data, err := a.suiGet(ctx, s, req.ConfigTarget)
	if err != nil {
		return "", err
	}
	if req.ConfigTarget == "settings" || req.ConfigTarget == "config" {
		if fingerprint(mustJSON(configCategory(data, req.ConfigTarget))) != c.Fingerprint {
			return "", errors.New("configuration changed after preview; preview again")
		}
	} else if req.ConfigMode == "new" {
		list := objectList(data, req.ConfigTarget)
		var expected map[string]any
		if err := json.Unmarshal(c.After, &expected); err != nil {
			return "", err
		}
		key := configNameKey(req.ConfigTarget)
		for _, item := range list {
			if reflect.DeepEqual(item[key], expected[key]) {
				return "", fmt.Errorf("%s already exists after preview; preview again", key)
			}
		}
		if req.ConfigTarget == "inbounds" {
			for _, item := range list {
				if reflect.DeepEqual(item["listen"], expected["listen"]) && reflect.DeepEqual(item["listen_port"], expected["listen_port"]) {
					return "", errors.New("listen address and port became occupied after preview; preview again")
				}
			}
		}
	} else {
		item, err := configItem(objectList(data, req.ConfigTarget), req.ConfigIdentity)
		if err != nil {
			return "", err
		}
		if fingerprint(mustJSON(item)) != c.Fingerprint {
			return "", errors.New("object changed after preview; preview again")
		}
		if configNameKey(req.ConfigTarget) == "tag" && req.ConfigMode != "del" {
			var after map[string]any
			if err := json.Unmarshal(c.After, &after); err != nil {
				return "", err
			}
			if stringField(item, "tag") != stringField(after, "tag") {
				refs, err := configTagReferences(ctx, a, s, req.ConfigTarget, item, stringField(item, "tag"))
				if err != nil {
					return "", err
				}
				if len(refs) > 0 {
					return "", fmt.Errorf("Tag gained references after preview: %s", strings.Join(refs, ", "))
				}
			}
		}
	}
	if req.ConfigTarget == "clients" && req.ConfigInboundsByServer != nil {
		tags := req.ConfigInboundsByServer[strconv.FormatInt(s.ID, 10)]
		ids, err := resolveConfigInboundTags(ctx, a, s, tags)
		if err != nil {
			return "", fmt.Errorf("inbounds changed after preview: %w", err)
		}
		var expected map[string]any
		if err := json.Unmarshal(c.After, &expected); err != nil {
			return "", err
		}
		if fingerprint(mustJSON(ids)) != fingerprint(mustJSON(expected["inbounds"])) {
			return "", errors.New("inbound IDs changed after preview; preview again")
		}
	}
	backup, err := a.backup(ctx, s)
	if err != nil {
		return "", err
	}
	mode, payload := req.ConfigMode, c.After
	if req.ConfigTarget == "config" || req.ConfigMode == "patch" {
		mode = "edit"
	}
	if req.ConfigTarget == "settings" {
		payload = req.Object
	}
	if req.ConfigMode == "del" {
		payload = c.Before
	}
	if err := a.suiPost(ctx, s, "save", url.Values{"object": {req.ConfigTarget}, "action": {mode}, "data": {string(payload)}}); err != nil {
		return backup, err
	}
	updated, err := a.suiGet(ctx, s, req.ConfigTarget)
	if err != nil {
		return backup, fmt.Errorf("save accepted, verification unavailable; refresh panel connection if its address changed: %w", err)
	}
	if req.ConfigTarget == "settings" {
		patch, _ := configPayload(req.Object)
		actual, _ := configCategory(updated, "settings").(map[string]any)
		for key, value := range patch {
			if !reflect.DeepEqual(actual[key], value) {
				return backup, fmt.Errorf("save accepted, setting %s did not match", key)
			}
		}
		return backup, nil
	}
	if req.ConfigTarget == "config" {
		if fingerprint(mustJSON(updated["config"])) != fingerprint(c.After) {
			return backup, errors.New("save accepted, core config did not match preview")
		}
		return backup, nil
	}
	list := objectList(updated, req.ConfigTarget)
	if req.ConfigMode == "del" {
		if _, err := configItem(list, req.ConfigIdentity); err == nil {
			return backup, errors.New("save accepted, object still exists")
		}
		return backup, nil
	}
	var expected map[string]any
	_ = json.Unmarshal(c.After, &expected)
	key := configNameKey(req.ConfigTarget)
	var actual map[string]any
	for _, item := range list {
		if item[key] == expected[key] {
			actual = item
			break
		}
	}
	if actual == nil {
		return backup, errors.New("save accepted, object not found afterwards")
	}
	var before map[string]any
	_ = json.Unmarshal(c.Before, &before)
	for field, value := range expected {
		if req.ConfigMode != "new" && reflect.DeepEqual(before[field], value) {
			continue
		}
		if !reflect.DeepEqual(actual[field], value) {
			return backup, fmt.Errorf("save accepted, field %s did not match", field)
		}
	}
	if req.ConfigMode != "new" {
		for field := range before {
			if _, kept := expected[field]; !kept {
				if _, remains := actual[field]; remains {
					return backup, fmt.Errorf("save accepted, field %s was not removed", field)
				}
			}
		}
	}
	return backup, nil
}
