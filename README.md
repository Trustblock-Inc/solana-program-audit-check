# solana-program-audit-check

Give it a Solana program ID. It prints one JSON object that answers four plain questions:

1. **Can the code still change?** Upgradeable or immutable, read from the chain.
2. **Who can change it?** The upgrade authority, and whether it is a single key, a Squads multisig, SPL Governance or another program's address.
3. **Is the deployed build verified?** The status in OtterSec's public verified-builds registry (repository and commit when it is).
4. **Which published audits name this program?** Looked up on [Trustblock](https://app.trustblock.run), the public record of security audits.

![check.js on two programs](docs/demo.gif)

*The recording shortens the waits for the network; a real run takes a few seconds per program.*

It is a read-only script of about 300 lines. It has no dependencies, needs no API key and no account, and writes nothing.

## Run it

Node 18 or newer.

```
node check.js <program-id>
node check.js <program-id> <program-id> ...        # several: prints a JSON array
node check.js $(cat examples/programs.txt)         # the seven example programs
```

Options:

| Option | What it does |
|---|---|
| `--rpc <url>` | Use your own Solana RPC endpoint. Default: `https://api.mainnet-beta.solana.com`, or the `SOLANA_RPC` environment variable. |
| `--no-registry` | Skip the verified-builds lookup. |
| `--no-trustblock` | Skip the Trustblock lookup. |
| `--compact` | One-line JSON. |

Exit code: 0 when every program was read, 1 if any returned an `error`.

## What it reads

| Source | Calls per program | Used for |
|---|---|---|
| Solana JSON-RPC | `getAccountInfo` on the program and on its ProgramData account, `getBlockTime` for the last deploy; for a PDA authority, `getAccountInfo` on the authority and up to 3 recent transactions (`getSignaturesForAddress`, `getTransaction`) to recognise a Squads vault | upgradeability, authority, last deploy date |
| `https://verify.osec.io/status/<program-id>` | 1 | verified-build status, repository, commit |
| `https://app.trustblock.run` (the public pages) | 1 search, 1 project page, 1 audit page per audit on the project (at most 8) | audits whose scope names this exact address |

Calls are made one after another with short pauses. A `429` from any source stops the run for that program with a clear message; it never retries in a loop. If you check many programs, pass your own RPC with `--rpc`.

## Example output

`node check.js Dj3WtDk7CRz64URJzmBjARpwBw7J9wwzm6JLdd8j8CaP`

```json
{
  "programId": "Dj3WtDk7CRz64URJzmBjARpwBw7J9wwzm6JLdd8j8CaP",
  "checkedAt": "2026-10-20T20:16:19.000Z",
  "onChain": {
    "rpc": "api.mainnet-beta.solana.com",
    "loader": "BPFLoaderUpgradeable",
    "state": "upgradeable",
    "reason": "upgrade authority set",
    "upgradeAuthority": "AyVqPRV2ER8M8rzixsAu9tgCTUze5QfhssGCwfDeQ7cQ",
    "upgradeAuthorityKind": "single key (wallet)",
    "lastDeploySlot": 273723700,
    "lastDeployAt": "2024-06-24"
  },
  "verifiedBuild": { "registry": "OtterSec verified builds (verify.osec.io)", "verified": false, "repo": null, "commit": null, "lastVerifiedAt": null, "message": "On chain program not verified" },
  "trustblock": {
    "found": true,
    "projects": [{ "slug": "russianroulette", "name": "RussianRoulette", "url": "https://app.trustblock.run/project/russianroulette", "auditsOnProject": 1 }],
    "audits": [{ "project": "russianroulette", "firm": "SolidProof", "date": "2024-06-25", "url": "https://app.trustblock.run/audit/315a19fc-7624-49f6-b2c6-c9a821833279" }],
    "otherAuditsOnSameProject": 0,
    "note": "Audits listed are those whose scope on Trustblock names this exact address."
  },
  "deployedAfterLatestAudit": false
}
```

### Fields

- `onChain.state`: `immutable` (upgrade authority revoked, legacy loader, or loader v4 finalized) or `upgradeable`.
- `onChain.upgradeAuthorityKind`: `single key (wallet)`, `Squads v4 multisig (vault | account)`, `Squads v3 multisig`, `SPL Governance`, or `program-derived address (other program)`. A wallet key lies on the ed25519 curve and a program-derived address does not; Squads vaults are recognised from the account owner or from the program named in the authority's latest transactions.
- `verifiedBuild`: what the registry says today. `verified: true` means the registry rebuilt the repository at that commit and the result matches the deployed program. It does not say anything about the quality of the code.
- `trustblock.audits`: the audits whose scope on Trustblock lists this exact address. `otherAuditsOnSameProject` counts audits on the same project that do not name it. A project can list a program without any audit naming it.
- `deployedAfterLatestAudit`: `true` when the last deploy is later than the newest audit that names the program; `null` when no audit names it. It flags that the code on chain may differ from the audited code. It does not prove that it does.

## The seven example programs

`examples/seven-programs.json` is the output for the seven programs below, read on 20 Oct 2026. They are the Solana programs that Trustblock found when it matched its stored Solana addresses to executables on mainnet (six are named in a published audit's scope today; the seventh is listed on a project but no audit names it).

| Program | Project | State | Authority | Last deploy | Verified build | Audits naming it |
|---|---|---|---|---|---|---|
| `5V4rLY8k…U6VJ` | DopaMeme | immutable | revoked | 2024-07-17 | no | SolidProof 2024-07-20 |
| `7m9a323Z…79E7` | Booh World | immutable | revoked | 2024-10-29 | no | SolidProof 2024-11-07 |
| `8ofzU3py…iCZ` | Booh World | immutable | revoked | 2024-10-15 | no | SolidProof 2024-09-23, 2024-11-07 |
| `DKFEeXbL…Dvi` | Booh World | immutable | revoked | 2024-10-15 | no | SolidProof 2024-09-23, 2024-11-07 |
| `Dj3WtDk7…CaP` | RussianRoulette | upgradeable | single key | 2024-06-24 | no | SolidProof 2024-06-25 |
| `dexrBFKX…QRx` | BulbaSwap | upgradeable | Squads v3 multisig | 2024-06-11 | no | SolidProof 2024-06-22 |
| `MPSoLoEn…YpAW` | Meta Pool | upgradeable | Squads v4 vault | 2026-07-27 | yes | none names it |

## Limits, stated plainly

- It reads three public sources and reports what they say today. It does not review code and says nothing on whether a program is safe.
- The Trustblock lookup matches by address. An audit that covers a program without listing its address in its scope on Trustblock will not appear here.
- Authority classification is a best effort: a PDA that is not a Squads or governance account is reported as `program-derived address (other program)`. If the RPC cannot read the authority's history the field says so instead of guessing.
- Public RPC nodes sometimes fail a history read; the script retries twice and then reports the failure.
- Solana mainnet only.

## Status and licence

Early script, version 0.1. Licence: MIT pending Bilel (no `LICENSE` file yet, so for now all rights are reserved).

Questions or corrections: open an issue once the repository is public.
