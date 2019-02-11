# babel-plugin-jsx-to-schema

babel plugin that can transform react jsx code to schema object

**Babel 6 Plugin**

## Usage

```javascript
const path = require('path');
const fs = require('fs');
const babel = require('babel-core');
const jsxToSchemaPlugin = require('babel-plugin-jsx-to-schema');

const code = fs.readFileSync(path.join('./', 'code.js'));

const result = babel.transform(code, {
    plugins: [jsxToSchemaPlugin],
});

fs.writeFileSync(path.join('./', 'schema'), result.code);
```
