# PAY-10 test fixtures (test-only)

These files exist only for offline PAY-10 protocol tests. None of them can
access a WeChat Pay account, merchant platform, certificate download, refund or
transfer API, and none of them is a real merchant credential.

| File | Source / purpose | Account privilege |
| --- | --- | --- |
| `wechat-pay-test-merchant-key.pem` | **Official WeChat Pay documentation's published test merchant API private key** (used by the signing examples on `4012365334` / `4012365339`). Required to reproduce the official request-signature and JSAPI `paySign` known-answer vectors byte-for-byte. | None. It is public documentation material, not a registered merchant key. |
| `wechat-pay-test-platform-test-public-key.pem` | Public half of a locally generated RSA-2048 key pair. The private half is **not** committed; it only backs the fixed deterministic response-verification vector in `pay-10-signing.test.ts`. | None. Verification-only public key. |
| `wechat-pay-test-platform-public-key.pem` | Official **public** key published on the `4013053249` (微信支付公钥) documentation page. Used only as a negative vector: that page's example signature does **not** verify with this key, while the paired key on `4013053420` does. | None. Public key only. |
| `wechat-pay-test-support.ts` | Test helper: generates a throwaway RSA-2048 platform key pair in-process on every test run, signs fake `127.0.0.1` responses, and asserts Authorization headers. The generated private key is never written to disk or committed. | None. Ephemeral test key. |

## Private-key boundary

- No real merchant API private key, real platform certificate, APIv3 key,
  AppSecret, merchant number or payment capability is present in this
  repository or its history.
- The only committed private key is the WeChat Pay documentation's **published
  test key**, which has no account access. The fake-response signing key is
  generated at test startup on purpose, so no generated private key enters Git.
- The repository rule "真实商户密钥不入仓" is therefore respected. If maintainers
  apply a literal "no private key PEM of any kind in Git" rule, the official KAT
  would have to be downloaded at test time or dropped; that is a maintainer
  decision recorded here rather than silently weakening the official vector.
