# eMudhra distrust fixtures

These are public CA certificates, containing no private keys. Retrieved on
2026-10-22 from the incident advisory's [roots](https://emudhra.we-have-a-problem.com/roots.json)
and [intermediates](https://emudhra.we-have-a-problem.com/impacted-intermediates.json).

The JSON retains the certificate names, PEM certificates, and independently
published SHA-256 public-key fingerprints. It covers four trust anchors and
sixteen certificate representations of the eight compromised intermediate keys,
including the alternate/cross-signed certificates. Tests use the frozen fixtures
without contacting the incident hosts.

`synthetic-tls-ca.pem` is an unrelated self-signed CA generated solely for these
tests. Its private key was discarded; it is not used outside isolated test
processes. This fixture checks that an additional configured CA survives the
filter even when it is not in Node's bundled trust store.
