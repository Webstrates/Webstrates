function indexOf(el) {
  return el && el.parentNode
  ? dir(el, "previousSibling").length
  : -1
}

function dir(elem, dir) {
  var matched = [],
    cur = elem[dir];

  while (cur) {
    matched.push(cur);
    cur = cur[dir];
  }
  return matched;
}

function cssPath(el, root) {
  return _cssPath(el, [], root)
}

function _cssPath(el, path, root) {
  if (!el || getNodeName(el) === 'html' || el === root) return path

  var elSelector = [getNodeName, getIdSelector, getClassSelector, indexOf]
  .map(function(func) { return func(el) }) // apply functions

  result = {node: elSelector[0], id: elSelector[1], class: elSelector[2], childIndex: elSelector[3]}
  path.unshift(result)
  return _cssPath(el.parentNode, path, root)
}

/**
 * Get element's .class .list
 * @param {Element} dom element
 * @return {String} classes of element as CSS selector
 */

function getClassSelector(el) {
  return el.className && el.className.split(' ')
  .map(function(className) { return '.' + className })
  .join('')
}

/**
 * Get element #id
 *
 * @param {Element} dom element
 * @return {String} id of element as CSS selector
 */

function getIdSelector(el) {
  return el.id ? '#' + el.id : ''
}

/**
 * Get element node name (e.g. div, li, body)
 *
 * @param {Element} dom element
 * @return {String} node name of element as CSS selector
 */

function getNodeName(el) {
  return (el.nodeName).toLowerCase()
}

