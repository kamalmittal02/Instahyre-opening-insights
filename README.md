# Instahyre Salary Insight

Chrome extension that shows market salary data when you open a job on Instahyre.

## Flow

1. You click a job on Instahyre.
2. The extension intercepts Instahyre's employer profile API call.
3. It looks up salary data in this order:
   - **Glassdoor**
   - **AmbitionBox**
   - **LeetCode**
4. The first source with usable salary data wins.
5. Results are cached for 6 hours.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

Then open [Instahyre Opportunities](https://www.instahyre.com/candidate/opportunities/) and click a job.

## Source reliability

| Source | Reliability | Notes |
|--------|-------------|-------|
| AmbitionBox | High | Uses public search + salary pages with embedded JSON |
| Glassdoor | Low–Medium | Often blocked by Cloudflare; works best in-browser |
| LeetCode | Low | Useful for larger companies with discuss compensation posts |

For smaller companies like GeoIQ, AmbitionBox is usually the best source.

## Example

For **GeoIQ · AI Engineer**, AmbitionBox may return:

- Role-specific range if a matching profile exists
- Otherwise company-wide average such as **₹22.1 LPA** from employee reports

## Files

- `inject.js` — intercepts Instahyre API responses
- `content.js` — renders the panel and requests external salary lookup
- `background.js` — fetches Glassdoor → AmbitionBox → LeetCode
- `manifest.json` — extension permissions and config

## Reload after changes

After editing code, go to `chrome://extensions` and click **Reload** on this extension.
