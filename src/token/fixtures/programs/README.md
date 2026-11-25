# Program binaries used by the token tests

`dynamic_bonding_curve.so` and `cp_amm.so` are the programs deployed on Solana mainnet, dumped on
25 November 2026 from their program data accounts through the public RPC (the ELF cut at the end of
its section header table, the rest of the program data account is zero padding):

| file | program id | program data account | last deployed slot | sha256 |
| --- | --- | --- | --- | --- |
| dynamic_bonding_curve.so | dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN | HUfnSSiJxgspQm6C1rkqv6L3XgVtn7AESApgCQpCXCYh | 457502600 | c9f45da65b0c87ca76c1ed5ad0d1ef2ead7c3392e8e41f194d50296820a22bb9 |
| cp_amm.so (DAMM v2) | cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG | AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH | 457080014 | ca7a32627e284798de74eab2c8c3fe5c904c02b282f93a3314d5ad5bc92e5a67 |

The earlier copies (from the SDK repository, listed below) differed from mainnet. Every token test
and every launch tool test passes on the mainnet binaries (33 and 18 tests).

`metaplex.so` is still the copy from the SDK repository below; it could not be dumped from mainnet
here (the public RPC's data allowance ran out). Its account layout is the stable Metaplex one.

Earlier source of all three, copied unchanged from the test fixtures of the Meteora DBC SDK repository
(github.com/MeteoraAg/dynamic-bonding-curve-sdk, commit ad12772956f31a774caa0b43dfa288ef6976977f,
path packages/dynamic-bonding-curve/tests/fixtures), the same files that repository loads into
its own test validator for SDK version 2.0.0, the version installed here.

| file | program id | sha256 |
| --- | --- | --- |
| dynamic_bonding_curve.so (replaced) | dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN | 85f43457764052cb243060c3c6eed131861cf89419b121a2ea5a6f6009b52c7e |
| cp_amm.so (DAMM v2, replaced) | cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG | 586ed1f98c38db6cc4f3f03382575a2ae82671c0532a29aeddd8aa77c56924c9 |
| metaplex.so (token metadata) | metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s | 28d1fcad13c77e5c976289a6983d1258309af4a9762cf50aef80b5537732e87f |

They are only loaded into LiteSVM by tests. The service never loads them.
No pump.fun or Streamflow program binaries are public, so those paths are tested as built
transactions instead.
