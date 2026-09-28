FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /fleet-manager .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 fleet && mkdir /data && chown fleet:fleet /data
COPY --from=build /fleet-manager /usr/local/bin/fleet-manager
USER fleet
ENV FLEET_LISTEN=0.0.0.0:18780 FLEET_DATA_DIR=/data
EXPOSE 18780
ENTRYPOINT ["/usr/local/bin/fleet-manager"]
