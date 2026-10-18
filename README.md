# Auction service

One small service that runs open auctions for any number of properties.

## Rules (set per property in `auctions.json`)
- The first confirmed bid at or above `minBid` starts a `durationDays` countdown.
- Every later bid must beat the high bid by at least `increment`.
- A confirmed bid inside the final `softCloseHours` moves the close to `softCloseHours` after that bid.
- A bid counts only after the bidder clicks the link emailed to them.
- The seller never bids. Every bid is stored with a timestamp.

## Environment variables (set in Render)
| Name | Value |
|---|---|
| `PUBLIC_BASE_URL` | The service's own https URL, no trailing slash |
| `ADMIN_TOKEN` | A long random string. Opens the seller view at `/admin/<auction id>?token=...` |
| `SELLER_EMAIL` | Where new-bid and auction-ended alerts go |
| `SMTP_USER` | Gmail address that sends the emails |
| `SMTP_PASS` | A Gmail app password (not the normal password) |
| `DATA_DIR` | `/var/data` (the persistent disk mount path) |
| `NODE_VERSION` | `22` |

## Add another property
Add an entry to `auctions.json` (copy an existing one), commit, and redeploy. Then build that site's `auction.html`
with `build_auction_page.py`.
