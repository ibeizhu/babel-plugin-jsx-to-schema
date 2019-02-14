/**
 * babel plugin that can transform react jsx code to schema object
 * @param t
 * @return {{inherits: *, visitor: {JSXElement: visitor.JSXElement}}}
 */
module.exports = function({ types: t }) {
  let STYLE_VARIABLE_DECLARATOR = null;
  let STYLE_VARIABLE_NAME = '';

  /**
   * find global style or styles variable
   * @param path
   */
  const findStyleVariableDeclarator = path => {
    const variableDeclaratorNodes = path.node.body.filter(node =>
      t.isVariableDeclaration(node)
    );
    variableDeclaratorNodes.forEach(node => {
      if (!Array.isArray(node.declarations)) {
        return false;
      }
      node.declarations.forEach(declarationNode => {
        const variableName = declarationNode.id.name;
        if (
          t.isVariableDeclarator(declarationNode) &&
          (variableName === 'style' || variableName === 'styles')
        ) {
          STYLE_VARIABLE_NAME = variableName;
          STYLE_VARIABLE_DECLARATOR = declarationNode;
        }
      });
    });
  };

  /**
   * find real css data node
   * @param node
   * @return {*}
   */
  const findStyleObjectProperty = node => {
    let result = null;
    const styleKey = node.property.name;
    const styleName = node.object.name;
    if (styleName !== STYLE_VARIABLE_NAME) {
      return result;
    }
    const properties = STYLE_VARIABLE_DECLARATOR.init.properties || [];
    properties.forEach(styleObjectProperty => {
      if (styleObjectProperty.key.name === styleKey) {
        result = styleObjectProperty.value;
      }
    });
    return result;
  };

  /**
   * transform style of JSXAttribute
   * @param node
   * @return {*}
   */
  const buildStyleObjectExpression = node => {
    let result = null;
    switch (node.type) {
      case 'MemberExpression': {
        // style={styles.a}
        result = findStyleObjectProperty(node);
        break;
      }
      case 'ObjectExpression': {
        // style={{...styles.a, ...styles.b}} get first style by default
        (node.properties || []).forEach(propertyNode => {
          if (t.isSpreadProperty(propertyNode)) {
            let currentNode = propertyNode.argument;
            if (t.isMemberExpression(currentNode) && !result) {
              result = findStyleObjectProperty(currentNode);
            }
          }
        });
        break;
      }
      case 'ConditionalExpression': {
        // style={true ? styles.a : styles.b} get first style by default
        // TODO beizhu more stage as `style.a` maybe a SpreadProperty type
        if (t.isMemberExpression(node.consequent)) {
          result = findStyleObjectProperty(node.consequent);
        }
        break;
      }
      // other stage case ?
    }
    return result;
  };

  function getJSXElementName(node) {
    let name = '';
    switch (node.type) {
      case 'JSXIdentifier': {
        // <Comp />
        name = node.name;
        break;
      }
      case 'JSXMemberExpression': {
        // <Comp.A.B.C />
        name = `${getJSXElementName(node.object)}.${node.property.name}`;
        break;
      }
    }
    return name;
  }

  /**
   * decorate JSXText accord PI schema spec
   * @param path
   */
  function decorateJSXElementChildren(path) {
    let children = path.get('children');
    if (Array.isArray(children)) {
      // filter empty JSXText
      children = children.filter(child => {
        if (t.isJSXText(child.node)) {
          child.node.value = child.node.value.trim();
          if (child.node.value.replace(/[\r\n]/g, '') === '') {
            return false;
          }
        }
        return true;
      });

      // transform accord to PI render engine rule
      const standardDomElements = [
        'p',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'div',
        'span',
        'a',
      ];
      const textAttributeName = 'data_text';
      let node = path.node.openingElement;
      let elementName = node.name.name;
      if (
        standardDomElements.indexOf(elementName) > -1 &&
        children.length === 1 &&
        t.isJSXText(children[0])
      ) {
        let text = children[0].node.value;
        let attrName = t.JSXIdentifier(textAttributeName);
        let attrValue = t.StringLiteral(text);
        node.attributes.push(t.JSXAttribute(attrName, attrValue));
        children = [];
      }
    }
    return children;
  }

  /**
   * transform JSXElement to ObjectExpression
   * @param path
   * @param state
   * @return {*}
   */
  const generateElement = (path, state) => {
    const FILE = state.file;
    const OPTIONS = Object.assign(
      {},
      {
        type: 'component',
        extends: 'extends',
        attributes: 'props',
        children: 'children',
      },
      state.opts
    );

    const NODE = path.node;

    if (!/JSXElement/.test(NODE.type)) {
      return NODE.expression ? NODE.expression : t.StringLiteral(NODE.value);
    }

    let OPENING_ELEMENT = NODE.openingElement;
    let ELEMENT_ATTRIBUTES = OPENING_ELEMENT.attributes;

    let CHILDREN = decorateJSXElementChildren(path);

    let type = t.StringLiteral(getJSXElementName(OPENING_ELEMENT.name));
    let attributes = ELEMENT_ATTRIBUTES.length
      ? buildAttributeObject(ELEMENT_ATTRIBUTES, FILE)
      : t.NullLiteral();
    let children = CHILDREN.length
      ? t.ArrayExpression(CHILDREN.map(child => generateElement(child, state)))
      : t.ArrayExpression([]);

    return t.ObjectExpression([
      t.ObjectProperty(
        t.StringLiteral(OPTIONS.type),
        type
      ),
      t.ObjectProperty(t.StringLiteral(OPTIONS.attributes), attributes),
      t.ObjectProperty(t.StringLiteral(OPTIONS.children), children),
    ]);
  };

  /**
   * transform JSXAttribute to ObjectExpression
   * @param nodes
   * @return {[*]}
   */
  const generateAttrObject = nodes => {
    let arr = nodes.map(node => {
      let name = t.StringLiteral(node.name.name);
      let value;
      if (!node.value) {
        value = t.BooleanLiteral(true);
      } else if (/JSXExpressionContainer/i.test(node.value.type)) {
        value = node.value.expression;
        if (
          !t.isStringLiteral(value) &&
          !t.isNumericLiteral(value) &&
          !t.isBooleanLiteral(value)
        ) {
          // some dynamic variable attributes can not be analysed
          // replace with constant string
          const attributeName = name.value;
          switch (attributeName) {
            case 'style': {
              if (STYLE_VARIABLE_DECLARATOR) {
                let result = buildStyleObjectExpression(value);
                if (result) {
                  value = result;
                }
              }
              break;
            }
            case 'src': {
              value = t.StringLiteral(
                'https://gw.alicdn.com/tfs/TB11pUKDiLaK1RjSZFxXXamPFXa-400-400.png'
              );
              break;
            }
            case 'href': {
              value = t.StringLiteral('#path');
              break;
            }
            default: {
              value = t.StringLiteral('PlaceHolder Text');
              break;
            }
          }
        }
      } else {
        value = node.value;
      }
      return t.ObjectProperty(name, value);
    });

    return [t.ObjectExpression(arr)];
  };

  const buildAttributeObject = function(attrs, file) {
    let _expressions = [],
      _spreads = [];

    while (attrs.length) {
      let attr = attrs.shift();

      /^JSXSpreadAttribute$/i.test(attr.type)
        ? _spreads.push(attr.argument)
        : _expressions.push(attr);
    }

    let attrObject = _expressions.length
      ? generateAttrObject(_expressions)
      : null;

    if (_spreads.length) {
      let extension = attrObject ? _spreads.concat(attrObject) : _spreads;

      if (extension.length > 1) extension.unshift(t.ObjectExpression([]));

      attrObject = t.callExpression(file.addHelper('extends'), extension);
    } else {
      attrObject = attrObject[0];
    }

    return attrObject;
  };

  return {
    inherits: require('babel-plugin-transform-react-jsx'),
    pre: function() {
      this.ROOT_PATH = null;
      this.SCHEMA_NODE = null;
    },
    visitor: {
      Program: function(path, state) {
        this.ROOT_PATH = path;
        findStyleVariableDeclarator(path, state);
      },
      JSXElement: function(path, state) {
        path.replaceWith(generateElement(path, state));
      },
      ClassMethod: {
        exit: function(path, state) {
          // only select render function code
          if (path.get('key').node.name === 'render') {
            const body = path.get('body').get('body');
            const returnStatement = body.filter(node =>
              t.isReturnStatement(node)
            );
            if (returnStatement.length) {
              this.SCHEMA_NODE = returnStatement[0].get('argument').node;
            }
          }
        },
      },
    },
    post: function() {
      if (this.SCHEMA_NODE) {
        this.ROOT_PATH.node.body = [this.SCHEMA_NODE];
      }
    },
  };
};
