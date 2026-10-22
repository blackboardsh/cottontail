// Real TLS handshakes exercise serialized client sessions and encrypted server
// tickets across a security-policy upgrade. Every fixture is loopback-only.
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tls_blocked_spkis.h"
#include "tls_session_policy.h"

static const char *fixtures;

static void check(int condition, const char *message) {
    if (condition) return;
    fprintf(stderr, "FAIL: %s\n", message);
    ERR_print_errors_fp(stderr);
    exit(1);
}

static void fixture_path(char *target, const char *name) {
    int length = snprintf(target, 1024, "%s/%s", fixtures, name);
    check(length > 0 && length < 1024, "fixture path length");
}

static X509 *certificate(const char *name) {
    char path[1024];
    fixture_path(path, name);
    BIO *bio = BIO_new_file(path, "r");
    check(bio != NULL, "read certificate");
    X509 *result = PEM_read_bio_X509(bio, NULL, NULL, NULL);
    BIO_free(bio);
    check(result != NULL, "parse certificate");
    return result;
}

static SSL_CTX *context(int version, bool server, bool blocked, bool client_auth, bool policy) {
    SSL_CTX *ctx = SSL_CTX_new(TLS_method());
    check(ctx != NULL, "SSL_CTX_new");
    check(SSL_CTX_set_min_proto_version(ctx, version) == 1, "minimum TLS version");
    check(SSL_CTX_set_max_proto_version(ctx, version) == 1, "maximum TLS version");
    check(SSL_CTX_set_session_id_context(ctx, (const unsigned char *)"probe", 5) == 1, "session ID context");
    SSL_CTX_set_session_cache_mode(ctx, server ? SSL_SESS_CACHE_SERVER : SSL_SESS_CACHE_CLIENT);
    if (server || client_auth) {
        X509 *leaf = certificate(blocked ? "native-emsign-crosssigned-leaf.pem" : "native-tls-control-leaf.pem");
        check(SSL_CTX_use_certificate(ctx, leaf) == 1, "use leaf certificate");
        X509_free(leaf);
        char key[1024];
        fixture_path(key, "tls-test-key.pem");
        check(SSL_CTX_use_PrivateKey_file(ctx, key, SSL_FILETYPE_PEM) == 1, "use leaf private key");
        if (blocked) {
            check(SSL_CTX_add_extra_chain_cert(ctx, certificate("native-emsign-crosssigned-intermediate.pem")) == 1,
                "use cross-signed issuer");
        }
    }
    X509 *root = certificate("native-tls-test-ca.pem");
    check(X509_STORE_add_cert(SSL_CTX_get_cert_store(ctx), root) == 1, "trust unrelated test root");
    X509_free(root);
    SSL_CTX_set_verify(ctx, server
        ? (client_auth ? SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT : SSL_VERIFY_NONE)
        : SSL_VERIFY_PEER, NULL);
    if (policy) {
        SSL_CTX_set_cert_verify_callback(ctx, ct_tls_verify_chain, NULL);
        check(SSL_CTX_set_session_ticket_cb(ctx, ct_tls_generate_session_ticket,
            ct_tls_decrypt_session_ticket, NULL) == 1, "install session ticket policy");
    }
    return ctx;
}

static int stamp_new_session(SSL *ssl, SSL_SESSION *session) {
    ct_tls_stamp_session_policy(ssl, session);
    return 0;
}

typedef struct {
    SSL *client;
    SSL *server;
    bool ok;
} Pair;

static Pair handshake(SSL_CTX *client_ctx, SSL_CTX *server_ctx, SSL_SESSION *resume, bool gate) {
    Pair pair = { SSL_new(client_ctx), SSL_new(server_ctx), false };
    check(pair.client != NULL && pair.server != NULL, "SSL_new");
    BIO *client_bio, *server_bio;
    check(BIO_new_bio_pair(&client_bio, 0, &server_bio, 0) == 1, "memory BIO pair");
    SSL_set_bio(pair.client, client_bio, client_bio);
    SSL_set_bio(pair.server, server_bio, server_bio);
    SSL_set_connect_state(pair.client);
    SSL_set_accept_state(pair.server);
    if (resume != NULL && (!gate || ct_tls_session_has_current_policy(resume))) {
        check(SSL_set_session(pair.client, resume) == 1, "apply session");
    }
    // Memory BIOs avoid network timing and make each unsuccessful handshake bounded.
    for (int iteration = 0; iteration < 100; iteration++) {
        int client_result = SSL_do_handshake(pair.client);
        int client_error = SSL_get_error(pair.client, client_result);
        int server_result = SSL_do_handshake(pair.server);
        int server_error = SSL_get_error(pair.server, server_result);
        if (client_result == 1 && server_result == 1) {
            pair.ok = true;
            break;
        }
        if ((client_result != 1 && client_error != SSL_ERROR_WANT_READ && client_error != SSL_ERROR_WANT_WRITE) ||
            (server_result != 1 && server_error != SSL_ERROR_WANT_READ && server_error != SSL_ERROR_WANT_WRITE)) break;
    }
    if (pair.ok) {
        check(SSL_write(pair.server, "x", 1) == 1, "write application byte");
        char value;
        // This also processes the TLS 1.3 tickets sent after the handshake.
        check(SSL_read(pair.client, &value, 1) == 1 && value == 'x', "read application byte and session tickets");
    }
    return pair;
}

static SSL_SESSION *export_session(Pair *pair, bool stamp) {
    SSL_SESSION *session = SSL_get1_session(pair->client);
    check(session != NULL, "get session");
    if (stamp) ct_tls_stamp_session_policy(pair->client, session);
    unsigned char *data = NULL;
    int length = i2d_SSL_SESSION(session, &data);
    check(length > 0, "serialize session");
    SSL_SESSION_free(session);
    const unsigned char *cursor = data;
    SSL_SESSION *copy = d2i_SSL_SESSION(NULL, &cursor, length);
    OPENSSL_free(data);
    check(copy != NULL, "deserialize session");
    return copy;
}

static void close_pair(Pair pair) {
    SSL_set_quiet_shutdown(pair.client, 1);
    SSL_set_quiet_shutdown(pair.server, 1);
    SSL_shutdown(pair.client);
    SSL_shutdown(pair.server);
    SSL_free(pair.client);
    SSL_free(pair.server);
    ERR_clear_error();
}

int main(int argc, char **argv) {
    check(argc == 2, "usage: tls-session-policy <fixture-directory>");
    fixtures = argv[1];
    for (int variant = 0; variant < 2; variant++) {
        int version = variant ? TLS1_3_VERSION : TLS1_2_VERSION;
        SSL_CTX *good_server = context(version, true, false, false, true);
        SSL_CTX *client = context(version, false, false, false, true);
        SSL_CTX_sess_set_new_cb(client, stamp_new_session);
        Pair first = handshake(client, good_server, NULL, true);
        check(first.ok, "good initial handshake");
        SSL_SESSION *session = export_session(&first, true);
        check(ct_tls_session_has_current_policy(session), "good session stamped");
        check(SSL_SESSION_is_resumable(session), "good session resumable");
        Pair second = handshake(client, good_server, session, true);
        check(second.ok, "good resumed handshake");
        check(SSL_session_reused(second.client), "good session actually reused");
        SSL_SESSION *renewed = export_session(&second, true);
        check(ct_tls_session_has_current_policy(renewed), "resumed and renewed session policy retained");
        close_pair(second);
        close_pair(first);
        SSL_SESSION_free(session);
        SSL_SESSION_free(renewed);
        SSL_CTX_free(good_server);

        SSL_CTX *old_server = context(version, true, true, false, false);
        SSL_CTX *old_client = context(version, false, false, false, false);
        Pair old = handshake(old_client, old_server, NULL, false);
        check(old.ok, "old client trusts cross-signed compromised chain");
        SSL_SESSION *legacy = export_session(&old, false);
        check(!ct_tls_session_has_current_policy(legacy), "legacy session unmarked");
        Pair vulnerable = handshake(client, old_server, legacy, false);
        check(vulnerable.ok && SSL_session_reused(vulnerable.client),
            "without provenance the old session bypasses the new certificate callback");
        check(SSL_get0_verified_chain(vulnerable.client) == NULL, "legacy resumed session omits issuer chain");
        close_pair(vulnerable);
        Pair protected = handshake(client, old_server, legacy, true);
        check(!protected.ok, "legacy client session forces full-chain rejection");
        check(SSL_get_verify_result(protected.client) == X509_V_ERR_CERT_REVOKED,
            "legacy client session rejects with CERT_REVOKED");
        close_pair(protected);
        close_pair(old);
        SSL_SESSION_free(legacy);
        SSL_CTX_free(old_server);
        SSL_CTX_free(old_client);
        SSL_CTX_free(client);

        // Server tickets can survive a runtime update when users persist ticketKeys.
        SSL_CTX *mtls_server = context(version, true, false, true, false);
        SSL_CTX *bad_client = context(version, false, true, true, true);
        SSL_CTX_sess_set_new_cb(bad_client, stamp_new_session);
        Pair before = handshake(bad_client, mtls_server, NULL, true);
        check(before.ok, "old mTLS server accepts compromised client issuer");
        SSL_SESSION *ticket = export_session(&before, true);
        check(ct_tls_session_has_current_policy(ticket), "client has valid server provenance");
        SSL_CTX_set_cert_verify_callback(mtls_server, ct_tls_verify_chain, NULL);
        check(SSL_CTX_set_session_ticket_cb(mtls_server, ct_tls_generate_session_ticket,
            ct_tls_decrypt_session_ticket, NULL) == 1, "update mTLS ticket policy");
        Pair after = handshake(bad_client, mtls_server, ticket, true);
        check(!after.ok, "legacy encrypted mTLS ticket forces full-chain rejection");
        check(SSL_get_verify_result(after.server) == X509_V_ERR_CERT_REVOKED,
            "legacy mTLS ticket rejects with CERT_REVOKED");
        close_pair(after);
        close_pair(before);
        SSL_SESSION_free(ticket);
        SSL_CTX_free(mtls_server);
        SSL_CTX_free(bad_client);
        printf("PASS TLS1.%d good resumption, legacy client session, and legacy mTLS ticket\n", variant ? 3 : 2);
    }
    return 0;
}
