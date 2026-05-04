# k9s

A terminal UI to interact with Kubernetes clusters.

- **Docs**: <https://k9scli.io/topics/>
- **Repo**: <https://github.com/derailed/k9s>

## Local customizations

`config.yaml` uses the `catppuccin-mocha` skin, sets `defaultView: pods`, enables mouse-free navigation (`enableMouse: false`), and pins favorite namespaces (`tower`, `diplobot`) for the `stillhouse-basil-aks` cluster. Shell pods are limited to `100m` CPU / `100Mi` memory with a `busybox:1.37.0` image.
