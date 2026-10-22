// OpenSSL serializes a session's peer leaf and verification result, but not its
// issuer chain. Only sessions checked by this policy may skip that chain on a
// resumed handshake. Unmarked sessions safely fall back to a full handshake.
#ifndef COTTONTAIL_TLS_SESSION_POLICY_H
#define COTTONTAIL_TLS_SESSION_POLICY_H

// Rotate this marker whenever the denied keys or validation policy changes;
// sessions checked under an older policy must perform a fresh handshake.
static const unsigned char ct_tls_session_policy[] = "cottontail-spki-20261021-v1";

static bool ct_tls_session_has_current_policy(SSL_SESSION *session) {
    void *data = NULL;
    size_t length = 0;
    return session != NULL && SSL_SESSION_get0_ticket_appdata(session, &data, &length) == 1 &&
        data != NULL && length == sizeof(ct_tls_session_policy) - 1 &&
        memcmp(data, ct_tls_session_policy, length) == 0;
}

static void ct_tls_stamp_session_policy(SSL *ssl, SSL_SESSION *session) {
    if (ssl == NULL || session == NULL) return;
    if (SSL_session_reused(ssl)) {
        // Never promote a legacy session using only its retained leaf.
        if (!ct_tls_session_has_current_policy(SSL_get_session(ssl))) return;
    } else {
        // Clear any inherited marker before inspecting a fresh peer chain,
        // including a new chain received through TLS 1.2 renegotiation.
        (void)SSL_SESSION_set1_ticket_appdata(session, NULL, 0);
        X509 *peer = SSL_get0_peer_certificate(ssl);
        STACK_OF(X509) *verified = SSL_get0_verified_chain(ssl);
        STACK_OF(X509) *presented = SSL_get_peer_cert_chain(ssl);
        if (peer == NULL) {
            // Servers may intentionally accept clients without a certificate.
            if (!SSL_is_server(ssl)) return;
        } else {
            if (sk_X509_num(verified) <= 0 && sk_X509_num(presented) <= 0) return;
            if (SSL_get_verify_result(ssl) == X509_V_ERR_CERT_REVOKED ||
                ct_tls_blocked_key_error(peer) != X509_V_OK ||
                ct_tls_blocked_chain_error(verified) != X509_V_OK ||
                ct_tls_blocked_chain_error(presented) != X509_V_OK) return;
        }
    }
    // Allocation failure only disables resumption; it cannot permit a peer.
    (void)SSL_SESSION_set1_ticket_appdata(session, ct_tls_session_policy,
        sizeof(ct_tls_session_policy) - 1);
}

static int ct_tls_generate_session_ticket(SSL *ssl, void *argument) {
    (void)argument;
    ct_tls_stamp_session_policy(ssl, SSL_get_session(ssl));
    return 1;
}

static SSL_TICKET_RETURN ct_tls_decrypt_session_ticket(
    SSL *ssl, SSL_SESSION *session, const unsigned char *key_name,
    size_t key_name_length, SSL_TICKET_STATUS status, void *argument
) {
    (void)ssl;
    (void)key_name;
    (void)key_name_length;
    (void)argument;
    if (status == SSL_TICKET_FATAL_ERR_MALLOC || status == SSL_TICKET_FATAL_ERR_OTHER)
        return SSL_TICKET_RETURN_ABORT;
    if ((status != SSL_TICKET_SUCCESS && status != SSL_TICKET_SUCCESS_RENEW) ||
        !ct_tls_session_has_current_policy(session)) return SSL_TICKET_RETURN_IGNORE_RENEW;
    return status == SSL_TICKET_SUCCESS_RENEW ? SSL_TICKET_RETURN_USE_RENEW : SSL_TICKET_RETURN_USE;
}

#endif
