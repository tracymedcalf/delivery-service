// Use ESM imports instead of require()
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

class SignatureGenerator {

    generateSignature(keyB64Str, stringToSign) {
        // Check if the key already has PEM headers
        let privateKeyPem = keyB64Str;
        if (!keyB64Str.includes('-----BEGIN')) {
            // If not, add PEM headers
            privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${keyB64Str}\n-----END PRIVATE KEY-----`;
        } else {
            console.log("PEM headers are already in place. Moving on...")
        }
        
        const privateKey = crypto.createPrivateKey({
            key: privateKeyPem,
            format: 'pem', 
            type: 'pkcs8'
        });

        // Sign using SHA256 with RSA (matches Java's "SHA256WithRSA")
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(stringToSign, 'utf8');
        sign.end();

        return sign.sign(privateKey, 'base64');
    }

    static canonicalize(headersToSign) {
        let parameterNames = "";
        let canonicalizedValues = "";

        const sortedKeys = Object.keys(headersToSign).sort();

        for (const key of sortedKeys) {
            const val = headersToSign[key];
            parameterNames += `${key.trim()};`;
            canonicalizedValues += `${String(val).trim()}\n`;
        }

        return [parameterNames, canonicalizedValues];
    }

    buildAuthHeaders(consumerId, privateKey, privateKeyVersion = "1") {
        const intimestamp = Date.now();

        const map = {
            "WM_CONSUMER.ID": consumerId,
            "WM_CONSUMER.INTIMESTAMP": String(intimestamp),
            "WM_SEC.KEY_VERSION": privateKeyVersion
        };

        const array = SignatureGenerator.canonicalize(map);

        let signatureData = null;
        try {
            console.log(`Generating signature for ${array[1]}`)
            signatureData = this.generateSignature(privateKey, array[1]);
        } catch (e) {
            console.error(`Error generating signature: ${e}`);
            throw e;
        }

        return {
            "WM_CONSUMER.ID": consumerId,
            "WM_CONSUMER.INTIMESTAMP": String(intimestamp),
            "WM_SEC.KEY_VERSION": privateKeyVersion,
            "WM_SEC.AUTH_SIGNATURE": signatureData
        };
    }
}

// Make an authenticated call to the Walmart catalog API
async function makeWalmartCatalogCall(requestObj) {
    const {
        url,
        method = 'GET',
        headers = {},
        timeout = 30000,
        consumerId,
        privateKey: pkParam = null
    } = requestObj;

    if (!url) {
        throw new Error("API request URL is required");
    }

    const generator = new SignatureGenerator();

    // Read private key if not provided
    let privateKey = pkParam;
    if (!privateKey) {
        const keyPath = path.join(os.homedir(), '.walmart', 'WM_IO_private_key.pem');
        try {
            privateKey = fs.readFileSync(keyPath, 'utf-8').trim();
        } catch (err) {
            throw new Error(`Error reading private key from ${keyPath}: ${err.message}`);
        }
    }

    // Generate auth headers
    const authHeaders = generator.buildAuthHeaders(consumerId, privateKey);

    // Merge headers: auth headers take precedence
    const mergedHeaders = {
        "Content-Type": "application/json",
        ...headers,
        ...authHeaders
    };

    // Set up timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const fetchOptions = {
            method,
            headers: mergedHeaders,
            signal: controller.signal
        };

        const response = await fetch(url, fetchOptions);
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Main execution block
async function main() {
    const consumerId = process.env.CONSUMER_ID;
    if (!consumerId) {
        console.error("Error accessing environment variable CONSUMER_ID.");
        process.exit(1);
    }
    const keyPath = path.join(os.homedir(), '.walmart', 'WM_IO_private_key.pem');
    let privateKey;
    try {
        privateKey = fs.readFileSync(keyPath, 'utf-8').trim();
    } catch (err) {
        console.error(`Error reading private key from ${keyPath}:`, err.message);
        process.exit(1);
    }

    // Test the API call with a sample request
    const testRequest = {
        url: "https://developer.api.walmart.com/api-proxy/service/affil/product/v2/paginated/items",
        method: "GET",
        consumerId,
        privateKey
    };

    try {
        console.log("Making request to Walmart API...");
        const response = await makeWalmartCatalogCall(testRequest);
        console.log(`Response status: ${response.status}`);
        console.log(`Response headers:`, Object.fromEntries(response.headers.entries()));
        const text = await response.text();
        console.log(`Response body: ${text}`);
    } catch (error) {
        console.error("Error making API call:", error.message);
        process.exit(1);
    }
}

// Check if this file is being run directly (ESM equivalent to checking require.main === module)
if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1].endsWith('fetch_wm.js')) {
    main();
}