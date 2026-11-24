
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: MascotPart

> **MascotPart** = \{ `head?`: `never`; `label`: [`MascotPartLabel`](MascotPartLabel.md); `skull`: \{ `bottom`: `number`; `height`: `number`; `radius`: `number`; `top`: `number`; \}; `type`: `"shape"`; \} \| \{ `head`: [`MascotHeadComponent`](MascotHeadComponent.md); `label`: [`MascotPartLabel`](MascotPartLabel.md); `skull?`: `never`; `type`: `"shape"`; \} \| \{ `hex`: `string`; `label`: [`MascotPartLabel`](MascotPartLabel.md); `type`: `"color"`; \} \| \{ `blink?`: `boolean`; `label`: [`MascotPartLabel`](MascotPartLabel.md); `left`: readonly [`MascotPoint`](MascotPoint.md)[]; `middle?`: readonly [`MascotPoint`](MascotPoint.md)[]; `right?`: readonly [`MascotPoint`](MascotPoint.md)[]; `type`: `"eyes"`; \} \| \{ `label`: [`MascotPartLabel`](MascotPartLabel.md); `svg`: `string`; `tilt?`: `number`; `type`: `"acc"`; \}
