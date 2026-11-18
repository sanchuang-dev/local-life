# PAY-10 test fixtures (test-only)

These files exist only for offline PAY-10 protocol tests.

- `wechat-pay-test-merchant-key.pem` — the WeChat Pay documentation's **public
  test** merchant API certificate private key. It is published in the official
  docs for signing examples; it is not a real merchant credential and has no
  access to any account.
- `wechat-pay-test-platform-test-public-key.pem` /
  `wechat-pay-test-platform-private-key.pem` — a generated RSA 2048 pair used to
  sign fake WeChat responses in the controlled local HTTP server.

No real merchant number, merchant API private key, APIv3 key, AppSecret,
certificate or payment capability is present in this repository. The fixtures
only prove the protocol algorithm; they do not prove a real WeChat integration.
