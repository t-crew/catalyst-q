# Examples

These are inputs. Run them yourself to see what comes back.

```sh
npx catalyst-q run examples/bell.qasm --measure 0,1
npx catalyst-q run examples/toffoli-both-controls-set.qasm --measure 0,1,2
npx catalyst-q score examples/bell.qasm examples/counts-format.json
```

`counts-format.json` shows the format for device counts. Its numbers were typed by hand to show the shape, and they did not come from a device.
