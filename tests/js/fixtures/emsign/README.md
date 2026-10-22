These are public test certificates and a generated localhost test key. The key
is used only by loopback TLS regression tests and must never identify a real
service.

`emsign-blocked-intermediate.pem` is the public EM DV TLS CA - G3C certificate
from Bun's MIT-licensed security regression:
https://github.com/oven-sh/bun/pull/46300

The remaining certificates were generated for tests using that publicly
compromised intermediate key (known scalar 230) and an unrelated test CA.
The cross-signed and self-signed variants retain the compromised key while
changing the certificate fingerprint and issuer. This proves rejection is based
on SHA-256 of DER SubjectPublicKeyInfo, independent of the selected trust root.
The control leaf uses an unrelated key under the same test CA.

Leaves include both serverAuth and clientAuth, localhost and 127.0.0.1 SANs,
SHA-256 signatures, and validity from 2025-05-01 through 2036-01-01. Tests do not
require public network access or a current operating-system CA bundle.
