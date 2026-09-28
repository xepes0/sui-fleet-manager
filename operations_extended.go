package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"strings"
)

func isExtendedAction(action string) bool {
	switch action {
	case "inbound_create", "outbound_create", "outbound_patch", "route_rule_add", "route_rule_replace", "route_rule_delete":
		return true
	}
	return false
}

func decodeObject(raw json.RawMessage, label string) (map[string]any, error) {
	if len(raw) == 0 || len(raw) > 1<<16 {
		return nil, fmt.Errorf("%s must be a JSON object of at most 64 KiB", label)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil || len(value) == 0 {
		return nil, fmt.Errorf("%s must be a nonempty JSON object", label)
	}
	return value, nil
}

func validateExtendedRequest(req previewRequest) error {
	switch req.Action {
	case "inbound_create", "outbound_create":
		if strings.TrimSpace(req.SourceTag) != "" {
			patch, err := decodeObject(req.ObjectOverrides, "object overrides")
			if err != nil {
				return err
			}
			if strings.TrimSpace(stringField(patch, "tag")) == "" {
				return errors.New("new tag required")
			}
			for key := range patch {
				if key == "id" || key == "type" || key == "users" {
					return fmt.Errorf("cannot override %s when copying", key)
				}
			}
			if req.InboundPublicPort < 0 || req.InboundPublicPort > 65535 {
				return errors.New("invalid public port")
			}
			return nil
		}
		object, err := decodeObject(req.Object, "object template")
		if err != nil {
			return err
		}
		if strings.TrimSpace(stringField(object, "type")) == "" || strings.TrimSpace(stringField(object, "tag")) == "" {
			return errors.New("object template needs type and tag")
		}
		if _, ok := object["id"]; ok {
			return errors.New("omit id; S-UI assigns it when creating an object")
		}
	case "outbound_patch":
		if strings.TrimSpace(req.ObjectTag) == "" {
			return errors.New("outbound tag required")
		}
		patch, err := decodeObject(req.ObjectPatch, "outbound patch")
		if err != nil {
			return err
		}
		for key := range patch {
			if key == "id" || key == "tag" || key == "type" {
				return fmt.Errorf("cannot patch outbound %s", key)
			}
		}
	case "route_rule_add":
		if _, err := decodeObject(req.RouteRule, "route rule"); err != nil {
			return err
		}
		if req.RoutePosition != "first" && req.RoutePosition != "last" && req.RoutePosition != "before_index" {
			return errors.New("route position must be first, last, or before_index")
		}
		if req.RoutePosition == "before_index" && req.RouteIndex == nil {
			return errors.New("route index required for before_index")
		}
	case "route_rule_replace":
		if _, err := decodeObject(req.RouteRule, "route rule"); err != nil {
			return err
		}
		fallthrough
	case "route_rule_delete":
		if req.RouteIndex == nil {
			return errors.New("route index required")
		}
	}
	if req.RouteIndex != nil && (*req.RouteIndex < 0 || *req.RouteIndex > 1000) {
		return errors.New("route index must be between 0 and 1000")
	}
	return nil
}

func stringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func objectByTag(object map[string]any, listKey, tag string) (map[string]any, error) {
	var found map[string]any
	for _, entry := range objectList(object, listKey) {
		if entry["tag"] == tag {
			if found != nil {
				return nil, fmt.Errorf("duplicate %s tag on panel", listKey)
			}
			found = entry
		}
	}
	if found == nil {
		return nil, fmt.Errorf("%s tag not found on panel", listKey)
	}
	return found, nil
}

func objectTagExists(object map[string]any, listKey, tag string) bool {
	for _, entry := range objectList(object, listKey) {
		if entry["tag"] == tag {
			return true
		}
	}
	return false
}

func cloneMap(object map[string]any) map[string]any {
	copyObject := make(map[string]any, len(object))
	for key, value := range object {
		copyObject[key] = value
	}
	return copyObject
}

func routeConfig(object map[string]any) (map[string]any, []any, error) {
	config, ok := object["config"].(map[string]any)
	if !ok {
		return nil, nil, errors.New("S-UI did not return a config object")
	}
	route, exists := config["route"]
	if !exists || route == nil {
		return config, []any{}, nil
	}
	routeObject, ok := route.(map[string]any)
	if !ok {
		return nil, nil, errors.New("S-UI route config is not an object")
	}
	rawRules, exists := routeObject["rules"]
	if !exists || rawRules == nil {
		return config, []any{}, nil
	}
	rules, ok := rawRules.([]any)
	if !ok {
		return nil, nil, errors.New("S-UI route rules are not an array")
	}
	return config, rules, nil
}

func routeAfter(config map[string]any, rules []any) json.RawMessage {
	copyConfig := cloneMap(config)
	route, _ := config["route"].(map[string]any)
	copyRoute := cloneMap(route)
	copyRoute["rules"] = rules
	copyConfig["route"] = copyRoute
	result, _ := json.Marshal(copyConfig)
	return result
}

func (a *app) validateRouteTarget(ctx context.Context, s server, rule map[string]any) error {
	outbound := stringField(rule, "outbound")
	if outbound == "" {
		if stringField(rule, "action") == "" {
			return errors.New("route rule needs outbound or action")
		}
		return nil
	}
	for _, endpoint := range []string{"outbounds", "endpoints"} {
		object, err := a.suiGet(ctx, s, endpoint)
		if err != nil {
			return err
		}
		if objectTagExists(object, endpoint, outbound) {
			return nil
		}
	}
	return fmt.Errorf("route outbound tag %q does not exist on panel", outbound)
}

func previewExtended(ctx context.Context, a *app, s server, req previewRequest, c *change) {
	switch req.Action {
	case "inbound_create", "outbound_create":
		endpoint := "inbounds"
		if req.Action == "outbound_create" {
			endpoint = "outbounds"
		}
		object, err := a.suiGet(ctx, s, endpoint)
		if err != nil {
			c.Error = err.Error()
			return
		}
		var template map[string]any
		if req.SourceTag != "" {
			source, err := objectByTag(object, endpoint, req.SourceTag)
			if err != nil {
				c.Error = err.Error()
				return
			}
			template = cloneMap(source)
			delete(template, "id")
			delete(template, "users")
			var overrides map[string]any
			_ = json.Unmarshal(req.ObjectOverrides, &overrides)
			for key, value := range overrides {
				template[key] = value
			}
			if req.Action == "inbound_create" {
				out, _ := source["out_json"].(map[string]any)
				if out != nil || req.InboundPublicServer != "" {
					newOut := map[string]any{}
					for key, value := range out {
						newOut[key] = value
					}
					newOut["type"] = source["type"]
					if req.InboundPublicServer != "" {
						newOut["server"] = req.InboundPublicServer
					}
					if req.InboundPublicPort != 0 {
						newOut["server_port"] = req.InboundPublicPort
					}
					template["out_json"] = newOut
					if addresses, ok := source["addrs"].([]any); ok && len(addresses) > 0 {
						copyAddresses := append([]any{}, addresses...)
						first, _ := addresses[0].(map[string]any)
						copyFirst := cloneMap(first)
						if req.InboundPublicServer != "" {
							copyFirst["server"] = req.InboundPublicServer
						}
						if req.InboundPublicPort != 0 {
							copyFirst["server_port"] = req.InboundPublicPort
						}
						copyAddresses[0] = copyFirst
						template["addrs"] = copyAddresses
					} else if server, ok := newOut["server"].(string); ok && server != "" {
						template["addrs"] = []map[string]any{{"server": server, "server_port": newOut["server_port"]}}
					}
				}
			}
		} else {
			_ = json.Unmarshal(req.Object, &template)
			if req.Action == "inbound_create" && req.TLSRef != "" {
				tlsObjects, err := a.suiGet(ctx, s, "tls")
				if err != nil {
					c.Error = err.Error()
					return
				}
				matched := false
				for _, item := range objectList(tlsObjects, "tls") {
					if req.TLSRef == "tag:"+stringField(item, "tag") || req.TLSRef == "name:"+stringField(item, "name") || req.TLSRef == fmt.Sprintf("id:%v", item["id"]) {
						template["tls_id"] = item["id"]
						matched = true
						break
					}
				}
				if !matched {
					c.Error = "selected TLS certificate not found on panel"
					return
				}
			}
		}
		if objectTagExists(object, endpoint, stringField(template, "tag")) {
			c.Error = "tag already exists on panel"
			return
		}
		list, _ := json.Marshal(object[endpoint])
		c.Fingerprint = fingerprint(list)
		c.After, _ = json.Marshal(template)
	case "outbound_patch":
		object, err := a.suiGet(ctx, s, "outbounds")
		if err != nil {
			c.Error = err.Error()
			return
		}
		outbound, err := objectByTag(object, "outbounds", req.ObjectTag)
		if err != nil {
			c.Error = err.Error()
			return
		}
		var patch map[string]any
		_ = json.Unmarshal(req.ObjectPatch, &patch)
		merged := cloneMap(outbound)
		for key, value := range patch {
			merged[key] = value
		}
		c.Before, _ = json.Marshal(outbound)
		c.Fingerprint = fingerprint(c.Before)
		c.After, _ = json.Marshal(merged)
		if fingerprint(c.After) == c.Fingerprint {
			c.Error = "no fields changed"
		}
	case "route_rule_add", "route_rule_replace", "route_rule_delete":
		object, err := a.suiGet(ctx, s, "config")
		if err != nil {
			c.Error = err.Error()
			return
		}
		config, rules, err := routeConfig(object)
		if err != nil {
			c.Error = err.Error()
			return
		}
		var rule map[string]any
		if req.Action != "route_rule_delete" {
			_ = json.Unmarshal(req.RouteRule, &rule)
			if err := a.validateRouteTarget(ctx, s, rule); err != nil {
				c.Error = err.Error()
				return
			}
		}
		before := append([]any{}, rules...)
		after := append([]any{}, rules...)
		index := 0
		if req.RouteIndex != nil {
			index = *req.RouteIndex
		}
		switch req.Action {
		case "route_rule_add":
			if req.RoutePosition == "last" {
				index = len(after)
			}
			if index > len(after) {
				c.Error = "route index exceeds current rule count"
				return
			}
			after = append(after, nil)
			copy(after[index+1:], after[index:])
			after[index] = rule
		case "route_rule_replace":
			if index >= len(after) {
				c.Error = "route index does not exist"
				return
			}
			after[index] = rule
		case "route_rule_delete":
			if index >= len(after) {
				c.Error = "route index does not exist"
				return
			}
			after = append(after[:index], after[index+1:]...)
		}
		if reflect.DeepEqual(before, after) {
			c.Error = "no route rule changed"
			return
		}
		current, _ := json.Marshal(config)
		c.Fingerprint = fingerprint(current)
		c.Before, _ = json.Marshal(before)
		c.After, _ = json.Marshal(after)
		c.Payload = routeAfter(config, after)
	}
}

func executeExtended(ctx context.Context, a *app, s server, c change, req previewRequest) (string, error) {
	var endpoint, action string
	var payload json.RawMessage
	switch c.Action {
	case "inbound_create", "outbound_create", "outbound_patch":
		endpoint = "inbounds"
		if c.Action != "inbound_create" {
			endpoint = "outbounds"
		}
		object, err := a.suiGet(ctx, s, endpoint)
		if err != nil {
			return "", err
		}
		if c.Action == "outbound_patch" {
			current, err := objectByTag(object, endpoint, req.ObjectTag)
			if err != nil {
				return "", err
			}
			encoded, _ := json.Marshal(current)
			if fingerprint(encoded) != c.Fingerprint {
				return "", errors.New("outbound changed after preview; preview again")
			}
			action = "edit"
		} else {
			encoded, _ := json.Marshal(object[endpoint])
			if fingerprint(encoded) != c.Fingerprint {
				return "", errors.New("object list changed after preview; preview again")
			}
			action = "new"
		}
		payload = c.After
	case "route_rule_add", "route_rule_replace", "route_rule_delete":
		endpoint, action, payload = "config", "edit", c.Payload
		object, err := a.suiGet(ctx, s, endpoint)
		if err != nil {
			return "", err
		}
		config, _, err := routeConfig(object)
		if err != nil {
			return "", err
		}
		encoded, _ := json.Marshal(config)
		if fingerprint(encoded) != c.Fingerprint {
			return "", errors.New("route config changed after preview; preview again")
		}
	}
	backup, err := a.backup(ctx, s)
	if err != nil {
		return "", err
	}
	err = a.suiPost(ctx, s, "save", url.Values{"object": {endpoint}, "action": {action}, "data": {string(payload)}})
	if err != nil {
		return backup, err
	}
	object, err := a.suiGet(ctx, s, endpoint)
	if err != nil {
		return backup, fmt.Errorf("save accepted, verification unavailable: %w", err)
	}
	if endpoint == "config" {
		_, rules, err := routeConfig(object)
		if err != nil {
			return backup, fmt.Errorf("save accepted, verification failed: %w", err)
		}
		actual, _ := json.Marshal(rules)
		if fingerprint(actual) != fingerprint(c.After) {
			return backup, errors.New("save accepted, route rules did not match preview")
		}
		return backup, nil
	}
	var expected map[string]any
	_ = json.Unmarshal(c.After, &expected)
	actual, err := objectByTag(object, endpoint, stringField(expected, "tag"))
	if err != nil {
		return backup, fmt.Errorf("save accepted, verification failed: %w", err)
	}
	if c.Action == "outbound_patch" {
		var patch map[string]any
		_ = json.Unmarshal(req.ObjectPatch, &patch)
		expected = patch
	}
	for key, value := range expected {
		if !reflect.DeepEqual(actual[key], value) {
			return backup, fmt.Errorf("save accepted, %s field %s did not match", endpoint, key)
		}
	}
	return backup, nil
}
