# eslint-plugin-simbiat

Custom ESLint rules that are used in the [simbiat.eu](https://github.com/Simbiat/simbiat.ru) project. Created with the use of Claude AI (I am realistically not that proficient) but manually reviewed, adjusted, and tested on the existing codebase.

## Installation

```bash
npm install --save-dev eslint-plugin-simbiat
```

Requires ESLint
`>=9.38.0`, [flat config](https://eslint.org/docs/latest/use/configure/configuration-files), and [ESM](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c#how-can-i-make-my-typescript-project-output-esm).

---

## Usage (flat config)

```js
// eslint.config.js
import simbiat from 'eslint-plugin-simbiat';

export default [
  {
    plugins: { simbiat },
    rules: {
      'simbiat/no-forbidden-in-constructor':          'error',
      'simbiat/no-external-listeners-in-constructor': 'warn',
      'simbiat/prefer-field-initializer':             'warn',
      'simbiat/require-type-parameter':               'warn',
      'simbiat/require-super-first-in-constructor':   'error',
    },
  },
];
```

---

## Rules

### `simbiat/no-forbidden-in-constructor` - *problem*

Flags things the [Custom Elements spec](https://html.spec.whatwg.org/multipage/custom-elements.html#custom-element-conformance)
forbids in a constructor:

| Category               | Members                                                                                                                                                                                                                                                                                                                                                                                       |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Attribute manipulation | `this.setAttribute()`, `this.toggleAttribute()`, creation/update attributes like `this.id`, `this.className`, `this.tabIndex`, etc., that are not class fields.                                                                                                                                                                                                                               |
| Child-element access   | `this.children`, `this.childNodes`, `this.firstChild`, `this.lastChild`, `this.firstElementChild`, `this.lastElementChild`, `this.childElementCount`                                                                                                                                                                                                                                          |
| Child-element queries  | `this.querySelector()`, `this.querySelectorAll()`, `this.getElementsByTagName()`, `this.getElementsByClassName()`, `this.getElementsByName()`                                                                                                                                                                                                                                                 |
| Content mutation       | `this.innerHTML`, `this.outerHTML`, `this.textContent`, `this.innerText`, `this.appendChild()`, `this.insertBefore`, `this.replaceChild`, `this.removeChild()`, `this.append()`, `this.prepend()`, `this.replaceChildren()`, `this.insertAdjacentHTML()`, `this.insertAdjacentElement()`, `this.insertAdjacentText()`, `this.after()`, `this.before()`, `this.replaceWith()`, `this.remove()` |
| Global calls           | `document.write()`, `document.open()`                                                                                                                                                                                                                                                                                                                                                         |
| Illegal return         | Any `return <expr>;` that is not a bare `return;` or `return this;`                                                                                                                                                                                                                                                                                                                           |

Not flagged: `this.shadowRoot.*`, `this.attachShadow()`, `this.getAttribute()`,
`this.removeAttribute()`, `appendChild` on shadow-root elements, event
listeners on shadow-scoped elements.

**Options**

```js
'simbiat/no-forbidden-in-constructor': ['error', {
  baseClasses: ['HTMLElement', 'LitElement', 'BaseComponent'],
}]
```

`baseClasses` defaults to `['HTMLElement']`.

---

### `simbiat/no-external-listeners-in-constructor` - *suggestion*

Flags `addEventListener` calls on `document`, `window`, `document.body`,
`document.documentElement`, or `document.head` that appear **directly** in
the constructor body (not inside a nested callback or arrow function).

These listeners belong in `connectedCallback`, paired with removal in
`disconnectedCallback`; otherwise they leak when the element is moved or
re-inserted into the DOM.

**Options** - same `baseClasses` schema as above.

---

### `simbiat/require-super-first-in-constructor` - *problem*

Flags constructors, that do not start with empty
`super();`. This is normally flagged by TypeScript but may not be flagged in pure JavaScript.

**Options** - same `baseClasses` schema as above.

---

### `simbiat/require-listener-cleanup` - *suggestion*

Verifies that every `addEventListener` call on an external target inside
`connectedCallback` of an HTMLElement subclass has a matching `removeEventListener` call in `disconnectedCallback`.

**Options** - same `baseClasses` schema as above.

---

### `simbiat/prefer-field-initializer` - *suggestion*

Flags `this.x = expr` assignments in a constructor when all the following hold:

1. `x` already has a class field declaration (`PropertyDefinition`).
2. The RHS does **not** reference a constructor parameter by name.
3. The RHS does **not** contain `this.anything` (field-initializer vs.
   constructor-assignment ordering can differ subtly).

Only top-level assignments in the constructor body are checked. Assignments
inside `if`/`for`/`while` blocks, ternaries, or nested functions are
intentionally ignored.

> **Known limitation:** references to local variables defined earlier in the
> constructor (not parameters) are not detected and may produce false
> positives. Suppress with `// eslint-disable-next-line` where needed.

No auto-fix: the change requires removing the assignment *and* updating the
field declaration simultaneously.

---

### `simbiat/require-type-parameter` - *suggestion*

Flags `querySelector` and `querySelectorAll` calls in TypeScript (`.ts` /
`.tsx`) files that lack a type parameter.

```ts
// ✗ flagged
const element = document.querySelector('.link');

// ✓ OK
const element = document.querySelector<HTMLAnchorElement>('.link');
```

JS files are left alone. No auto-fix: the correct type depends on the
selector and must be supplied by the developer.
