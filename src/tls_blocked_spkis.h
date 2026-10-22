// Public-key distrust policy shared by every native TLS context.
// Source: Node.js d9a3f3d150f7959f2d448d9a61aa11f5a75aa2b3,
// src/crypto/crypto_context.cc; also Bun v1.4.4 blocked_spkis.cpp (MIT).
// Match DER SubjectPublicKeyInfo, not certificate names or fingerprints:
// cross-signing a compromised key must never restore its trust.
#ifndef COTTONTAIL_TLS_BLOCKED_SPKIS_H
#define COTTONTAIL_TLS_BLOCKED_SPKIS_H

#include <openssl/sha.h>

static const unsigned char ct_tls_blocked_spkis[][SHA256_DIGEST_LENGTH] = {
    // 0164d7ceae5bb909c272af151ff44b1177ae9b47d9424b94f1d9558c30934d19
    // C=US, O=eMudhra Inc, CN=EM DV TLS CA - G3C
    {0x49, 0xdd, 0x35, 0x3d, 0xc2, 0xb9, 0x19, 0xa3, 0x77, 0x06, 0x45,
     0x11, 0x7d, 0x0e, 0x60, 0xc1, 0x61, 0x15, 0xe7, 0xd1, 0xbc, 0x25,
     0x9e, 0xef, 0xe7, 0x34, 0xb0, 0x0e, 0xa4, 0x34, 0xfe, 0x5f},
    // 432ec25f0d28de9006d97bf752f17bbb2cd41f669933fcb072d9a1148d0261f3
    // C=US, O=eMudhra Inc, CN=EM EV TLS CA - G3C
    {0x5c, 0x06, 0x60, 0xa2, 0xb1, 0x64, 0x91, 0x0d, 0x8f, 0xf5, 0x89,
     0xc1, 0x8e, 0x14, 0x55, 0x2e, 0x9e, 0x0e, 0xc2, 0x37, 0xdc, 0xef,
     0xe2, 0xcb, 0x73, 0x6d, 0x41, 0xa4, 0x81, 0x1f, 0x81, 0xa0},
    // cb6e15165ac802e9b3f993f16c25d41f4e81c21ebde71ae1b012ac00bf9c7c3f
    // C=US, O=eMudhra Inc, CN=EM OV TLS CA - G3C
    {0x63, 0xec, 0xef, 0xee, 0x43, 0x1d, 0x49, 0x52, 0x3b, 0xc1, 0x13,
     0x6c, 0x4e, 0x72, 0xd0, 0x20, 0x6a, 0x47, 0x70, 0x86, 0xca, 0xf6,
     0x06, 0xcd, 0x5c, 0xf0, 0x25, 0x68, 0x6c, 0x10, 0x9c, 0xf8},
    // 4b2460a466f95fd40113bcdcca2ceb29b3b093921de45474da7df48874c630b1
    // C=US, O=eMudhra Inc, CN=EM OV CS CA - G3C
    {0x92, 0xc0, 0x63, 0xd6, 0x7e, 0x8f, 0x14, 0xdb, 0x71, 0xd2, 0x88,
     0xe1, 0x12, 0x66, 0xff, 0xda, 0xf6, 0x9c, 0xbf, 0x11, 0x5f, 0x7b,
     0xab, 0x14, 0xf3, 0xbc, 0x2f, 0x68, 0xd2, 0x5e, 0x0e, 0x30},
    // 42c4accd12c4f59597925e1a08a7a90102608543809308d50ec427e118ba1493
    // C=NL, O=eMudhra BV, CN=EM DV TLS CA - G3B
    {0xeb, 0xed, 0x64, 0x75, 0xc2, 0xc2, 0xd8, 0x0f, 0xcb, 0x19, 0x9f,
     0x3f, 0xe8, 0xdd, 0x6e, 0x6b, 0x3c, 0xe6, 0x0b, 0x77, 0xeb, 0x15,
     0xd4, 0xe4, 0x2c, 0x3d, 0xec, 0x0c, 0x6f, 0x5b, 0x51, 0x05},
    // 9e39de2881273acc225a149c72ba3e0f51424963669ab633ee1dc7df5db067b4
    // C=NL, O=eMudhra BV, CN=EM OV CS CA - G3B
    {0xec, 0x4f, 0xfa, 0x1a, 0xd0, 0xac, 0x88, 0x08, 0x13, 0x14, 0xb7,
     0xaa, 0xff, 0xef, 0x6a, 0x91, 0xf9, 0x7c, 0xd5, 0x72, 0x91, 0xbb,
     0x5b, 0xa6, 0x86, 0xc5, 0x41, 0x5f, 0x5e, 0xb4, 0xf6, 0xb6},
    // 98b896625c0c230adeec3eb2cf6aad5001ecf9156a68644e82374ce5833bc25b
    // C=NL, O=eMudhra BV, CN=EM OV TLS CA - G3B
    {0x43, 0xbf, 0xfa, 0x19, 0xd6, 0xef, 0x65, 0x14, 0x51, 0xf6, 0x84,
     0x1e, 0x01, 0x99, 0x31, 0xe9, 0x6f, 0x6f, 0x2e, 0xae, 0xff, 0x28,
     0xab, 0x4b, 0x6f, 0x1c, 0xe4, 0x57, 0x6d, 0xe2, 0x71, 0x7b},
    // e7568fe6e12331f4fd7de61da4c7559d0f8eb192a218d4741a3ba75184333838
    // C=NL, O=eMudhra BV, CN=EM EV TLS CA - G3B
    {0xe0, 0x25, 0x4c, 0x7f, 0xcd, 0xc2, 0x65, 0xe2, 0xf0, 0xf8, 0xa4,
     0x28, 0xda, 0xbb, 0x75, 0xab, 0x4a, 0xe0, 0x39, 0xb4, 0x87, 0x2d,
     0x62, 0xf5, 0xee, 0x57, 0xf0, 0x87, 0x7d, 0x5a, 0x8a, 0x41},
};

static int ct_tls_blocked_key_error(X509 *certificate) {
    unsigned char *spki = NULL;
    const int length = i2d_X509_PUBKEY(X509_get_X509_PUBKEY(certificate), &spki);
    if (length <= 0) return X509_V_ERR_UNSPECIFIED;
    unsigned char digest[SHA256_DIGEST_LENGTH];
    const unsigned char *hashed = SHA256(spki, (size_t)length, digest);
    OPENSSL_free(spki);
    if (hashed == NULL) return X509_V_ERR_UNSPECIFIED;
    for (size_t i = 0; i < sizeof(ct_tls_blocked_spkis) / sizeof(ct_tls_blocked_spkis[0]); i++) {
        if (memcmp(digest, ct_tls_blocked_spkis[i], sizeof(digest)) == 0) {
            return X509_V_ERR_CERT_REVOKED;
        }
    }
    return X509_V_OK;
}

static int ct_tls_blocked_chain_error(const STACK_OF(X509) *chain) {
    for (int i = 0; i < sk_X509_num(chain); i++) {
        const int error = ct_tls_blocked_key_error(sk_X509_value(chain, i));
        if (error != X509_V_OK) return error;
    }
    return X509_V_OK;
}

static int ct_tls_verify_chain(X509_STORE_CTX *store, void *argument) {
    const int verified = X509_verify_cert(store);
    int blocked_error = ct_tls_blocked_chain_error(X509_STORE_CTX_get0_chain(store));
    // An invalid chain may stop before its compromised issuer. Inspect the
    // supplied chain as well so the result remains CERT_REVOKED, regardless of
    // trust-store selection, issuer lookup, expiry, or cross-signing.
    if (blocked_error == X509_V_OK && X509_STORE_CTX_get_error(store) != X509_V_OK) {
        blocked_error = ct_tls_blocked_chain_error(X509_STORE_CTX_get0_untrusted(store));
    }
    if (blocked_error == X509_V_OK) return verified;
    X509_STORE_CTX_set_error(store, blocked_error);
    // Reject during the native handshake (including renegotiation), before
    // application data can become readable. Only explicit insecure contexts
    // may continue with an unauthorized peer.
    if (argument == NULL) return 0;
    // Preserve explicit rejectUnauthorized:false semantics, but retain the
    // authorization error for the caller and never mark the peer authorized.
    X509_STORE_CTX_verify_cb callback = X509_STORE_CTX_get_verify_cb(store);
    return callback != NULL ? callback(0, store) : 0;
}
#endif
