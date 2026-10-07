# Third-party source

`proto.ts`, `convert.ts`, and `devin.ts` are adapted from CaiJingLong/devin-gateway under the MIT license.

Source: https://github.com/CaiJingLong/devin-gateway
Commit: fdb1918055cdb8d5a359940bf3af38416d74d0c9
License: LICENSE.devin-gateway

Local changes: Node.js timer and fetch-body types. Logging and trace imports are replaced with no-op modules to avoid persisting upstream diagnostic content. No gateway HTTP server or upstream credential storage code is included.

Additional local changes: expose model cost tier and promotional metadata; forward optional billing response fields.

Local runtime compatibility: encode Metadata.ide_type and use a shared metadata builder with the custom client identity for authentication, model discovery, and inference.

Output configuration: omit max_tokens and max_newlines by default; max_tokens is encoded only when explicitly supplied by the caller.

Continuation handling: preserve Devin reasoning text, signature-only stream frames, and signature types across stored assistant messages and subsequent protobuf requests. Verified against the official Devin CLI 3000.10.21 wire format.
