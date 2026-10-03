# Campaign route cover: asset-free public runtime

Date: 2026-10-03 UTC

## Verified problem

The public v8 candidate's 行历山川 route details requested
`/shanmen-changming/assets/campaign/jade-mountain-route-v1.png`. The integration
owner's browser inspection found a completed image with zero natural width and
height, and a broken image icon inside a roughly 630 × 170 px empty banner.

The original 3,048,172-byte PNG is intentionally absent from Git and the public
Pages artifact, as documented in [large-assets.md](large-assets.md) and enforced
by the CI artifact checks. No lightweight equivalent exists in the repository.
The available small runtime sprites are characters and environment tiles, not
equivalent route banners.

## Narrow presentation fix

- `src/app/CampaignRouteMap.tsx` no longer creates an image or requests the excluded
  original. The existing decorative container remains `aria-hidden="true"`.
- `src/app/campaign-route-map.css` retains the existing jade gradients as an
  intentional asset-free header, reduced from 170 to 64 px on desktop and from
  125 to 48 px at the existing narrow-screen breakpoint. The obsolete image
  sizing rule is removed. No fetch, image error handler or runtime fallback
  race is needed.
- Route titles, descriptions, counterplay, prerequisites, rewards, route
  navigation, preparation guards and accessibility relationships are unchanged.
- No original artwork is modified, compressed, uploaded or added to Git. There
  is no new raster asset, external service, save change or simulation change.
  Restoring the optional original locally does not automatically make this
  component load it.

## Regression coverage and verification state

`tests/campaign-presentation/cover-runtime.test.tsx` adds three focused checks:

1. Asset-free decorative markup and retained localized route information,
   navigation selection and prepare control.
2. No excluded PNG or campaign asset-directory reference in the route view or
   its stylesheet.
3. Compact desktop/narrow header rules backed only by CSS gradients, with no
   image URL or obsolete image sizing dependency.

At worker handoff, source inspection and the narrow edit are complete. Tests,
type checks, production build, Git operations and browser verification have
**not been run by this worker**; the integration owner is the sole executor.

The owner should run the campaign-presentation tests and the normal applicable
type/build checks, then inspect the actual candidate route screen at desktop and
narrow widths. Confirm that no broken image icon or excluded-original request
remains, and that route selection, details and preparation continue to work.
This presentation fix is not a full campaign or game acceptance result.

集成记录（2026-10-03 04:15 UTC）：campaign-presentation 与共享布局共4文件19项测试通过，耗时3.52秒；1205文案键、内容校验、双类型及启用v8/v9的Pages构建通过。原始PNG仍未加入Git或发布产物。新装饰尚待部署后桌面/窄屏复核。
