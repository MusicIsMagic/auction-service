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
| `ADMIN_TOKEN` | Your dashboard password. Use a long random string. Sign in at `<service address>/admin` |
| `SELLER_EMAIL` | Where new-bid and auction-ended alerts go |
| `SMTP_USER` | Gmail address that sends the emails |
| `SMTP_PASS` | A Gmail app password (not the normal password) |
| `DATA_DIR` | `/var/data` (the persistent disk mount path) |
| `NODE_VERSION` | `22` |

## Seller dashboard (`/admin`)
- Overview of every property: status, high bid, bidders, anything waiting on email confirmation.
- Per property: every bid with contact details, fallback order, CSV download, activity history.
- Edit rules (minimum, increment, countdown, late-bid window, open and cutoff times) until the first bid is confirmed. After that they lock.
- Add a property, or delete one that has no bids.
- After an auction ends: winner status (awaiting escrow, escrow opened, paid, transferred, defaulted) and private notes.
- Test-email button to confirm Gmail sending works.

## Add another property
Use **Add a property** in the dashboard. Then build that site's `auction.html` with `tools/build_auction_page.py`.
(`auctions.json` only seeds the two starting properties on first run. After that, the dashboard is the source of truth.)
