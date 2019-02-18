(function (factory) {
  typeof define === 'function' && define.amd ? define(factory) :
  factory();
}(function () { 'use strict';

  /**
   * babel plugin that can transform react jsx code to schema object
   * @param t
   * @return {{inherits: *, visitor: {JSXElement: visitor.JSXElement}}}
   */
  module.exports = function (_ref) {
    var t = _ref.types;

    var STYLE_VARIABLE_DECLARATOR = null;
    var STYLE_VARIABLE_NAME = '';

    /**
     * find global style or styles variable
     * @param path
     */
    var findStyleVariableDeclarator = function findStyleVariableDeclarator(path) {
      var variableDeclaratorNodes = path.node.body.filter(function (node) {
        return t.isVariableDeclaration(node);
      });
      variableDeclaratorNodes.forEach(function (node) {
        if (!Array.isArray(node.declarations)) {
          return false;
        }
        node.declarations.forEach(function (declarationNode) {
          var variableName = declarationNode.id.name;
          if (t.isVariableDeclarator(declarationNode) && (variableName === 'style' || variableName === 'styles')) {
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
    var findStyleObjectProperty = function findStyleObjectProperty(node) {
      var result = null;
      var styleKey = node.property.name;
      var styleName = node.object.name;
      if (styleName !== STYLE_VARIABLE_NAME) {
        return result;
      }
      var properties = STYLE_VARIABLE_DECLARATOR.init.properties || [];
      properties.forEach(function (styleObjectProperty) {
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
    var buildStyleObjectExpression = function buildStyleObjectExpression(node) {
      var result = null;
      switch (node.type) {
        case 'MemberExpression':
          {
            // style={styles.a}
            result = findStyleObjectProperty(node);
            break;
          }
        case 'ObjectExpression':
          {
            // style={{...styles.a, ...styles.b}} get first style by default
            (node.properties || []).forEach(function (propertyNode) {
              if (t.isSpreadProperty(propertyNode)) {
                var currentNode = propertyNode.argument;
                if (t.isMemberExpression(currentNode) && !result) {
                  result = findStyleObjectProperty(currentNode);
                }
              }
            });
            break;
          }
        case 'ConditionalExpression':
          {
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
      var name = '';
      switch (node.type) {
        case 'JSXIdentifier':
          {
            // <Comp />
            name = node.name;
            break;
          }
        case 'JSXMemberExpression':
          {
            // <Comp.A.B.C />
            name = getJSXElementName(node.object) + '.' + node.property.name;
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
      var children = path.get('children');
      if (Array.isArray(children)) {
        // filter empty JSXText
        children = children.filter(function (child) {
          if (t.isJSXText(child.node)) {
            child.node.value = child.node.value.trim();
            if (child.node.value.replace(/[\r\n]/g, '') === '') {
              return false;
            }
          }
          return true;
        });

        // transform accord to PI render engine rule
        var standardDomElements = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'a', 'li', 'Button', 'Checkbox', 'Option'];
        var textAttributeName = 'data_text';
        var node = path.node.openingElement;
        var elementName = node.name.name;
        if (standardDomElements.indexOf(elementName) > -1) {
          if (children.length === 1 && t.isJSXText(children[0])) {
            var text = children[0].node.value;
            var attrName = t.JSXIdentifier(textAttributeName);
            var attrValue = t.StringLiteral(text);
            node.attributes.push(t.JSXAttribute(attrName, attrValue));
            children = [];
          } else if (children.length > 1) {
            children.map(function (item) {
              if (t.isJSXText(item)) {
                var _text = item.node.value;
                item.node = t.JSXElement(t.JSXOpeningElement(t.JSXIdentifier('span'), [], false), t.JSXClosingElement(t.JSXIdentifier('span')), [t.JSXText(_text)]);
              }
            });
          }
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
    var generateElement = function generateElement(path, state) {
      var FILE = state.file;
      var OPTIONS = Object.assign({}, {
        type: 'component',
        extends: 'extends',
        attributes: 'props',
        children: 'children'
      }, state.opts);

      var NODE = path.node;

      if (!/JSXElement/.test(NODE.type)) {
        return NODE.expression ? NODE.expression : t.StringLiteral(NODE.value);
      }

      var OPENING_ELEMENT = NODE.openingElement;
      var ELEMENT_ATTRIBUTES = OPENING_ELEMENT.attributes;

      var CHILDREN = decorateJSXElementChildren(path);

      var type = t.StringLiteral(getJSXElementName(OPENING_ELEMENT.name));
      var attributes = ELEMENT_ATTRIBUTES.length ? buildAttributeObject(ELEMENT_ATTRIBUTES, FILE) : t.NullLiteral();
      var children = CHILDREN.length ? t.ArrayExpression(CHILDREN.map(function (child) {
        return generateElement(child, state);
      })) : t.ArrayExpression([]);

      return t.ObjectExpression([t.ObjectProperty(t.StringLiteral(OPTIONS.type), type), t.ObjectProperty(t.StringLiteral(OPTIONS.attributes), attributes), t.ObjectProperty(t.StringLiteral(OPTIONS.children), children)]);
    };

    /**
     * transform JSXAttribute to ObjectExpression
     * @param nodes
     * @return {[*]}
     */
    var generateAttrObject = function generateAttrObject(nodes) {
      var arr = nodes.map(function (node) {
        var name = t.StringLiteral(node.name.name);
        var value = void 0;
        if (!node.value) {
          value = t.BooleanLiteral(true);
        } else if (/JSXExpressionContainer/i.test(node.value.type)) {
          value = node.value.expression;
          if (!t.isStringLiteral(value) && !t.isNumericLiteral(value) && !t.isBooleanLiteral(value)) {
            // some dynamic variable attributes can not be analysed
            // replace with constant string
            var attributeName = name.value;
            switch (attributeName) {
              case 'style':
                {
                  if (STYLE_VARIABLE_DECLARATOR) {
                    var result = buildStyleObjectExpression(value);
                    if (result) {
                      value = result;
                    }
                  }
                  break;
                }
              case 'src':
                {
                  value = t.StringLiteral('https://gw.alicdn.com/tfs/TB11pUKDiLaK1RjSZFxXXamPFXa-400-400.png');
                  break;
                }
              case 'href':
                {
                  value = t.StringLiteral('#path');
                  break;
                }
              default:
                {
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

    var buildAttributeObject = function buildAttributeObject(attrs, file) {
      var _expressions = [],
          _spreads = [];

      while (attrs.length) {
        var attr = attrs.shift();

        /^JSXSpreadAttribute$/i.test(attr.type) ? _spreads.push(attr.argument) : _expressions.push(attr);
      }

      var attrObject = _expressions.length ? generateAttrObject(_expressions) : null;

      if (_spreads.length) {
        var extension = attrObject ? _spreads.concat(attrObject) : _spreads;

        if (extension.length > 1) extension.unshift(t.ObjectExpression([]));

        attrObject = t.callExpression(file.addHelper('extends'), extension);
      } else {
        attrObject = attrObject[0];
      }

      return attrObject;
    };

    return {
      inherits: require('babel-plugin-transform-react-jsx'),
      pre: function pre() {
        this.ROOT_PATH = null;
        this.SCHEMA_NODE = null;
      },
      visitor: {
        Program: function Program(path, state) {
          this.ROOT_PATH = path;
          findStyleVariableDeclarator(path, state);
        },
        JSXElement: function JSXElement(path, state) {
          path.replaceWith(generateElement(path, state));
        },
        ClassMethod: {
          exit: function exit(path, state) {
            // only select render function code
            if (path.get('key').node.name === 'render') {
              var body = path.get('body').get('body');
              var returnStatement = body.filter(function (node) {
                return t.isReturnStatement(node);
              });
              if (returnStatement.length) {
                this.SCHEMA_NODE = returnStatement[0].get('argument').node;
              }
            }
          }
        }
      },
      post: function post() {
        if (this.SCHEMA_NODE) {
          this.ROOT_PATH.node.body = [this.SCHEMA_NODE];
        }
      }
    };
  };

}));
