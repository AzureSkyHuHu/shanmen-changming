# 大素材单独保存

用户于2026-10-01要求大素材不放入Git，保留在dot项目目录供下载。以下文件保留原字节，不删除、不压缩替换；Git只保留代码、小素材与清单。

- public/assets/portraits/disciples-atlas-v1.png：2,633,021字节，SHA-256 d26789c943b79e88bff680c46d52ea9ddbd08d9cd442f65be3f89efe2f2b6c5e
- public/assets/campaign/jade-mountain-route-v1.png：3,048,172字节，SHA-256 dbb071d0d9ca71e5de7a4e4017bd006a5cfeb6afff88fd0d6529e09b310bfc96
- assets-source/characters/contact-sheet-96-v2.svg：990,976字节，SHA-256 2ff646e3e0b135aabe8daf506fe589a746f86399957d29fa97a9038858ef9e87

使用完整美术时，将下载的文件按上述相对路径放回项目即可。没有大立绘图集时，人物信息面板使用仓库内的96像素角色图回退；场景人物和战斗像素素材正常保留。路线页的大背景是可选装饰，不承载游戏信息。

像素序列帧的SVG源图、素材联系表和视觉证明图片也单独保留在dot，不再纳入Git。仓库继续保留public/assets下体积很小的游戏运行贴图；生成源图的代码仍在仓库中。
