# 本机真实配置维护

仅在需要查看或修改当前用户的真实 `~/.mihomo-cli` 配置时阅读；开发、评审和隔离测试不需要本文，也不得拿真实配置做夹具

- 查改范围只限 `~/.mihomo-cli` 下的 `settings.json`、`overwrite*.yaml`、`overwrite*.mjs`
- 这些文件由 `~/space/dotfiles` 维护，快照为 `dots/dot-mihomo-cli.md`；改完必须 `dot save` 同步回 dotfiles 并在该仓提交，新机恢复用 `dot apply`
- 写入前先用 `dot save -n` 看差异；配置损坏时用 `dot apply -n` 看还原差异，`dot apply -y` 非交互还原。不要手搓 sed 修文件，多行清理容易留残迹，机制还原才是干净基线
- dotfiles 快照里的说明性注释（各订阅作用域、Seal 出口依赖）要随配置同步更新，不只保存文件内容
