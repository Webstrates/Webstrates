#!/bin/bash

# Script to generate self-signed SSL certificates for Webstrates development

# Get hostname parameter if provided, default to localhost
HOSTNAME=${1:-localhost}

echo "Generating SSL certificates for local development..."
echo "Using hostname: $HOSTNAME"

# Create ssl directory if it doesn't exist
mkdir -p ssl

# Build subject alternative names
SAN_LIST="DNS:localhost,IP:127.0.0.1,IP:0.0.0.0"
if [ "$HOSTNAME" != "localhost" ]; then
  SAN_LIST="DNS:localhost,DNS:$HOSTNAME,IP:127.0.0.1,IP:0.0.0.0"
fi

# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes \
  -subj "/C=US/ST=Development/L=Development/O=Webstrates/OU=Development/CN=$HOSTNAME" \
  -addext "subjectAltName=$SAN_LIST"
  
echo "SSL certificates generated successfully for $HOSTNAME!"
echo "Certificate: ssl/cert.pem"
echo "Private Key: ssl/key.pem"
echo "Subject Alternative Names: $SAN_LIST"
echo ""
echo "Note: These are self-signed certificates for development only."
echo "Your browser will show a security warning that you can safely ignore for local testing."