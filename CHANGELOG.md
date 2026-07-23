# Changelog

## [1.3.1](https://github.com/Yukihide-Mitsuoka/repchat/compare/v1.3.0...v1.3.1) (2026-07-22)


### Bug Fixes

* **governance:** adopt ruleset-only discovery ([#71](https://github.com/Yukihide-Mitsuoka/repchat/issues/71)) ([48d147a](https://github.com/Yukihide-Mitsuoka/repchat/commit/48d147a81d8210cf025e896c8787c3f5603195a9))
* **sync:** adopt safe parent propagation ([#69](https://github.com/Yukihide-Mitsuoka/repchat/issues/69)) ([697bd66](https://github.com/Yukihide-Mitsuoka/repchat/commit/697bd662c21964488fc99f0f39e50586d1701a89))

## [1.3.0](https://github.com/Yukihide-Mitsuoka/repchat/compare/v1.2.0...v1.3.0) (2026-07-20)


### Features

* **executor:** HTTP transport between gate and executor ([#65](https://github.com/Yukihide-Mitsuoka/repchat/issues/65)) ([#66](https://github.com/Yukihide-Mitsuoka/repchat/issues/66)) ([3a145b0](https://github.com/Yukihide-Mitsuoka/repchat/commit/3a145b049349123983dc36453582fe3a461e1e41))
* **gate:** wire the executor SEAM to the real executor ([#55](https://github.com/Yukihide-Mitsuoka/repchat/issues/55) A-3) ([#63](https://github.com/Yukihide-Mitsuoka/repchat/issues/63)) ([55bbda4](https://github.com/Yukihide-Mitsuoka/repchat/commit/55bbda4f3f76fac1e7171a4a135e634285196959))

## [1.2.0](https://github.com/Yukihide-Mitsuoka/repchat/compare/v1.1.0...v1.2.0) (2026-07-20)


### Features

* **executor:** BigQuery query runner over the REST jobs.query endpoint ([#59](https://github.com/Yukihide-Mitsuoka/repchat/issues/59)) ([01f50b5](https://github.com/Yukihide-Mitsuoka/repchat/commit/01f50b564ee36ed868ecb89f5e0426fabaf66cbc)), closes [#55](https://github.com/Yukihide-Mitsuoka/repchat/issues/55)

## [1.1.0](https://github.com/Yukihide-Mitsuoka/repchat/compare/v1.0.0...v1.1.0) (2026-07-19)


### Features

* **executor:** AST-level tenant-boundary binding for SQL queries ([#56](https://github.com/Yukihide-Mitsuoka/repchat/issues/56)) ([6ad2547](https://github.com/Yukihide-Mitsuoka/repchat/commit/6ad25471525af449083948bd627fee66026ae554)), closes [#55](https://github.com/Yukihide-Mitsuoka/repchat/issues/55)
* **executor:** execute use case with binding resolution and audit ([#58](https://github.com/Yukihide-Mitsuoka/repchat/issues/58)) ([a0435b7](https://github.com/Yukihide-Mitsuoka/repchat/commit/a0435b78433c11812fad3b40573a0e4d52ef4a2f)), closes [#55](https://github.com/Yukihide-Mitsuoka/repchat/issues/55)

## 1.0.0 (2026-07-19)


### Features

* **gate:** Cloudflare Workers interface — KV adapter, fetch handler, entry ([01848c8](https://github.com/Yukihide-Mitsuoka/repchat/commit/01848c800a9103cad9cbc997045cd01bc7b6409c))
* **gate:** Cloudflare Workers interface — KV adapter, fetch handler, entry ([8a2daf5](https://github.com/Yukihide-Mitsuoka/repchat/commit/8a2daf5acdb07b2c74f0ddbd331fdff7f16218d3)), closes [#23](https://github.com/Yukihide-Mitsuoka/repchat/issues/23)
* **gate:** in-memory + WebCrypto adapters and the ported acceptance suite ([39af2f6](https://github.com/Yukihide-Mitsuoka/repchat/commit/39af2f6969bc64eab6eed42abdc810025eeca5cc))
* **gate:** in-memory + WebCrypto adapters and the ported acceptance suite ([04a0550](https://github.com/Yukihide-Mitsuoka/repchat/commit/04a05500e70a63bee798fbcebbc891faf8ea8029)), closes [#23](https://github.com/Yukihide-Mitsuoka/repchat/issues/23)
* **gate:** runtime-agnostic gate core — domain + application layers ([28669c6](https://github.com/Yukihide-Mitsuoka/repchat/commit/28669c65cbbaa4416827c351277bbf579ba32bcc))
* **gate:** runtime-agnostic gate core — domain + application layers ([e6b34cd](https://github.com/Yukihide-Mitsuoka/repchat/commit/e6b34cdc74382339c5776693c75f9f8e4dfc834a)), closes [#23](https://github.com/Yukihide-Mitsuoka/repchat/issues/23)


### Bug Fixes

* satisfy CI — untrack package-lock.json, fix broken settings link ([70675fd](https://github.com/Yukihide-Mitsuoka/repchat/commit/70675fd5a42799d9505b2c03d9d428703548ceb8))
* **sync:** authenticate foundation documentation propagation ([#38](https://github.com/Yukihide-Mitsuoka/repchat/issues/38)) ([3eba6c7](https://github.com/Yukihide-Mitsuoka/repchat/commit/3eba6c70d59857ece4d79d5a5c493aab7e335140))
* **template-sync:** protect downstream workflow ownership ([#31](https://github.com/Yukihide-Mitsuoka/repchat/issues/31)) ([f14e1ab](https://github.com/Yukihide-Mitsuoka/repchat/commit/f14e1aba739cb9660ec5bbd364d8611884f1d29a))
