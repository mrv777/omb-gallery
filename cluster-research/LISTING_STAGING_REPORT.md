# Listing-staging wallet analysis

Generated: 2026-05-21T13:16:24.334Z
Database: `/Users/mrv/Documents/GitHub/ombs/omb-gallery/tmp/app-prod.db`

## Summary

Found **2,759** candidate evidence rows across **2,305** directed source -> seller wallet pairs.
This is a research-only signal. Real-profile Matrica conflicts take precedence over existing cluster overlap in the candidate classification.

## Trigger coverage

| trigger | scanned | kept | kept rate |
|---|---:|---:|---:|
| active_listing | 231 | 110 | 47.62% |
| listed_event | 174 | 71 | 40.80% |
| sold_event | 12,445 | 2,578 | 20.72% |

## Candidate classes

| class | pairs | cluster >=9500 | cluster >=9900 | same real | diff real | auto-shell | unknown |
|---|---:|---:|---:|---:|---:|---:|---:|
| known_same | 181 | 39 | 37 | 146 | 0 | 8 | 27 |
| known_conflict | 30 | 1 | 1 | 0 | 30 | 0 | 0 |
| repeated_fast_12h | 24 | 0 | 0 | 0 | 0 | 1 | 23 |
| repeated_fast_24h | 7 | 0 | 0 | 0 | 0 | 1 | 6 |
| single_fast_12h | 385 | 0 | 0 | 0 | 0 | 43 | 342 |
| single_fast_24h | 127 | 0 | 0 | 0 | 0 | 15 | 112 |
| outside_fast_window | 1,551 | 0 | 0 | 0 | 0 | 256 | 1,295 |

## Fast windows

| window | pairs | non-conflict pairs | repeated non-conflict | novel repeated non-conflict | listing pairs | sale pairs | sale-only | listing-only | mixed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| <=12h | 453 | 453 | 30 | 24 | 12 | 443 | 441 | 10 | 2 |
| <=24h | 594 | 591 | 41 | 32 | 13 | 583 | 581 | 11 | 2 |

## Gap buckets

| gap | evidence rows |
|---|---:|
| <=1h | 182 |
| <=6h | 230 |
| <=12h | 119 |
| <=1d | 156 |
| >1d | 2,072 |

## Precision proxy

The Matrica proxy only counts non-address usernames as real-profile labels. Address-like profiles are treated as auto-shells, not hard identity conflicts.

| validation | pairs |
|---|---:|
| same_real_profile | 146 |
| different_real_profile | 30 |
| auto_shell | 324 |
| unknown | 1,805 |

Real-profile labeled precision proxy: 82.95% same-profile among 176 labeled pairs.

## Cluster overlap

| measure | pairs |
|---|---:|
| existing cluster edge present | 1,300 |
| existing confidence >=9500 | 40 |
| existing confidence >=9900 | 38 |

## Top repeated fast 12h candidates

| source | seller | evidence | inscriptions | fast 12h insc | fast 24h insc | listing median | sale median | validation | cluster | seller holdings/listed |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| bc1qlwd5md...na20yl | bc1ql3yakz...k9zfle | 26 | 26 | 26 | 26 |  | 2.9h | unknown | 5000 | 0/0 |
| bc1ph2n2qa...lnhsue | bc1pytpz76...pg3275 | 8 | 8 | 8 | 8 |  | 23m | unknown |  | 0/0 |
| JCverse | bc1ph45683...fy9axs | 22 | 22 | 4 | 5 | 86d | 13d | unknown |  | 9/9 |
| etherhash | bc1p60lqwp...wu8wya | 9 | 9 | 4 | 6 |  | 19.4h | unknown |  | 0/0 |
| bc1ptjgjm3...lsxh0f | sammyp | 4 | 4 | 4 | 4 |  | 7.8h | auto_shell |  | 0/0 |
| lilswagoo | bc1pg6f0sh...ppta47 | 3 | 3 | 3 | 3 |  | 24m | unknown |  | 0/0 |
| bc1px2k60y...ty7nnh | bc1pwgtym9...9w45f2 | 3 | 3 | 3 | 3 |  | 2.6h | unknown | 8000 | 0/0 |
| bc1qy4wqrp...tq66aw | bc1pxvcx96...s6wa66 | 5 | 3 | 2 | 2 | 2m | 20d | unknown |  | 2/2 |
| bc1phu2azw...2we7gt | bc1pqdwpl5...52zd26 | 10 | 10 | 2 | 2 |  | 21d | unknown |  | 24/0 |
| bc1p7qymr4...myhk9c | bc1p427y2g...tejctg | 3 | 3 | 2 | 2 |  | 5.3h | unknown | 5000 | 0/0 |
| bc1qlfcam8...lxq527 | bc1q3w5vxq...a688pz | 3 | 3 | 2 | 2 |  | 6.6h | unknown | 8000 | 0/0 |
| bc1pa92elj...ez77an | bc1pl4df97...h2y3ry | 2 | 2 | 2 | 2 |  | 26m | unknown |  | 0/0 |
| bc1phfvrhw...qspn0n | bc1qnt7p8e...565pnv | 2 | 2 | 2 | 2 |  | 34m | unknown | 5000 | 0/0 |
| bc1px2k60y...ty7nnh | bc1p7uxtzw...dqa2p2 | 2 | 2 | 2 | 2 |  | 1.1h | unknown | 5000 | 0/0 |
| AntonisPr8Ordinals | bc1qsjmhey...y7tvwf | 2 | 2 | 2 | 2 |  | 1.5h | unknown | 5000 | 0/0 |

## Top repeated fast 24h candidates

| source | seller | evidence | inscriptions | fast 12h insc | fast 24h insc | listing median | sale median | validation | cluster | seller holdings/listed |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| bc1p27qzvw...w2cwrw | bc1phmg486...7gj3yu | 4 | 4 | 0 | 3 |  | 20.5h | unknown | 5000 | 0/0 |
| bc1pwcu88s...cse9v7 | bc1ph4rhe0...fheja7 | 3 | 3 | 1 | 2 |  | 19.6h | unknown | 5000 | 0/0 |
| Maccuratedart | bc1pkfzyl2...zsjqvr | 3 | 3 | 1 | 2 |  | 23.2h | unknown |  | 0/0 |
| BhS3Qwa4ksc3 | bc1pdftk7m...lenwx7 | 2 | 2 | 1 | 2 |  | 9.8h | unknown |  | 0/0 |
| bc1p07v2ch...pkg7sf | bc1pg4qytm...79cxlg | 2 | 2 | 1 | 2 |  | 12.1h | unknown | 5000 | 0/0 |
| bc1pcj4tn7...sw5nd9 | bc1pmvslsy...0jhsfu | 2 | 2 | 1 | 2 |  | 15.5h | auto_shell |  | 0/0 |
| 0xDeedz | bc1p8xcnd5...5q42ya | 2 | 2 | 0 | 2 |  | 17.6h | unknown | 8000 | 0/0 |

## Novel repeated fast 12h candidates

| source | seller | evidence | inscriptions | fast 12h insc | fast 24h insc | listing median | sale median | validation | cluster | seller holdings/listed |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| bc1qlwd5md...na20yl | bc1ql3yakz...k9zfle | 26 | 26 | 26 | 26 |  | 2.9h | unknown | 5000 | 0/0 |
| bc1ph2n2qa...lnhsue | bc1pytpz76...pg3275 | 8 | 8 | 8 | 8 |  | 23m | unknown |  | 0/0 |
| JCverse | bc1ph45683...fy9axs | 22 | 22 | 4 | 5 | 86d | 13d | unknown |  | 9/9 |
| etherhash | bc1p60lqwp...wu8wya | 9 | 9 | 4 | 6 |  | 19.4h | unknown |  | 0/0 |
| bc1ptjgjm3...lsxh0f | sammyp | 4 | 4 | 4 | 4 |  | 7.8h | auto_shell |  | 0/0 |
| lilswagoo | bc1pg6f0sh...ppta47 | 3 | 3 | 3 | 3 |  | 24m | unknown |  | 0/0 |
| bc1px2k60y...ty7nnh | bc1pwgtym9...9w45f2 | 3 | 3 | 3 | 3 |  | 2.6h | unknown | 8000 | 0/0 |
| bc1qy4wqrp...tq66aw | bc1pxvcx96...s6wa66 | 5 | 3 | 2 | 2 | 2m | 20d | unknown |  | 2/2 |
| bc1phu2azw...2we7gt | bc1pqdwpl5...52zd26 | 10 | 10 | 2 | 2 |  | 21d | unknown |  | 24/0 |
| bc1p7qymr4...myhk9c | bc1p427y2g...tejctg | 3 | 3 | 2 | 2 |  | 5.3h | unknown | 5000 | 0/0 |
| bc1qlfcam8...lxq527 | bc1q3w5vxq...a688pz | 3 | 3 | 2 | 2 |  | 6.6h | unknown | 8000 | 0/0 |
| bc1pa92elj...ez77an | bc1pl4df97...h2y3ry | 2 | 2 | 2 | 2 |  | 26m | unknown |  | 0/0 |
| bc1phfvrhw...qspn0n | bc1qnt7p8e...565pnv | 2 | 2 | 2 | 2 |  | 34m | unknown | 5000 | 0/0 |
| bc1px2k60y...ty7nnh | bc1p7uxtzw...dqa2p2 | 2 | 2 | 2 | 2 |  | 1.1h | unknown | 5000 | 0/0 |
| AntonisPr8Ordinals | bc1qsjmhey...y7tvwf | 2 | 2 | 2 | 2 |  | 1.5h | unknown | 5000 | 0/0 |

## Known conflicts

| source | seller | evidence | inscriptions | fast 12h insc | fast 24h insc | listing median | sale median | validation | cluster | seller holdings/listed |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| ApeSoda | nftboivault | 5 | 5 | 0 | 1 | 141d | 5.1d | different_real_profile |  | 6/6 |
| kenero | bc10000 | 5 | 5 | 0 | 0 | 6.6d | 6.6d | different_real_profile |  | 5/5 |
| 9LvUVvpHtUV7SXGLZRsvhkvN3krX1RnCTQukjrgMzTgm | onicchr | 2 | 2 | 0 | 1 |  | 15d | different_real_profile |  | 1/0 |
| btcnacho | ApeSoda | 1 | 1 | 0 | 1 |  | 16.2h | different_real_profile |  | 25/0 |
| davekebo | Maccuratedart | 1 | 1 | 0 | 0 |  | 1.1d | different_real_profile | 5000 | 0/0 |
| Mizike | XSangoX | 1 | 1 | 0 | 0 |  | 1.3d | different_real_profile |  | 1/0 |
| PixelRainbowNFT | ApeSoda | 1 | 1 | 0 | 0 |  | 2.1d | different_real_profile |  | 25/0 |
| JJL | dor1tolover | 1 | 1 | 0 | 0 |  | 3.5d | different_real_profile |  | 0/0 |
| SeriousOne | jacousteau | 1 | 1 | 0 | 0 |  | 4.8d | different_real_profile |  | 0/0 |
| Zzzz1414 | dylanbao | 1 | 1 | 0 | 0 |  | 7d | different_real_profile | 5000 | 0/0 |
| dkxbt1 | dkxbt | 1 | 1 | 0 | 0 |  | 9d | different_real_profile | 5000 | 0/0 |
| ordinalloops | paralleltoshi | 1 | 1 | 0 | 0 | 10d |  | different_real_profile |  | 2/2 |
| davekebo | ApeSoda | 1 | 1 | 0 | 0 |  | 14d | different_real_profile |  | 25/0 |
| BilliHoo | MobyTik1 | 1 | 1 | 0 | 0 |  | 32d | different_real_profile | 9900 | 0/0 |
| Brabo | THESCIENTIST99 | 1 | 1 | 0 | 0 |  | 34d | different_real_profile | 5000 | 0/0 |

## Interpretation notes

- `known_same` means same real Matrica user or existing cluster confidence >=9500, unless a different-real-profile conflict is present.
- `repeated_fast_12h` requires at least two distinct inscriptions with transfer-to-listing/sale gaps <=12 hours.
- `repeated_fast_24h` requires at least two distinct inscriptions with gaps <=24 hours, excluding pairs already in the 12h class.
- Single fast classes mean only one distinct inscription has fast evidence; useful for review, not linkage.
- `outside_fast_window` has no transfer-to-listing/sale evidence within 24 hours.
