#!/bin/sh
set -eu

src_cert=/root/cert/cert.crt
src_key=/root/cert/private.key
dst_dir=/etc/sui-fleet-manager/tls
dst_cert=$dst_dir/cert.crt
dst_key=$dst_dir/private.key

test -r "$src_cert"
test -r "$src_key"
openssl x509 -in "$src_cert" -noout -checkend 86400 >/dev/null
openssl x509 -in "$src_cert" -noout -checkhost "${FLEET_CERT_HOST:-fleet.example.com}" | grep -q 'does match'
cert_hash=$(openssl x509 -in "$src_cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d ' ' -f1)
key_hash=$(openssl pkey -in "$src_key" -pubout -outform DER | sha256sum | cut -d ' ' -f1)
test "$cert_hash" = "$key_hash"

install -d -m 0750 -o root -g sui-fleet /etc/sui-fleet-manager "$dst_dir"
if test -f "$dst_cert" && test -f "$dst_key" && cmp -s "$src_cert" "$dst_cert" && cmp -s "$src_key" "$dst_key"; then
    echo 'fleet TLS certificate unchanged'
    exit 0
fi

install -m 0640 -o root -g sui-fleet "$src_cert" "$dst_cert.new"
install -m 0640 -o root -g sui-fleet "$src_key" "$dst_key.new"
mv -f "$dst_cert.new" "$dst_cert"
mv -f "$dst_key.new" "$dst_key"
echo 'fleet TLS certificate updated'

if test "${1:-}" != '--no-restart'; then
    systemctl try-restart sui-fleet-manager
fi
