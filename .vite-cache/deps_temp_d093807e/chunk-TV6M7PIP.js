import {
  require_react
} from "./chunk-OC5S6P4L.js";
import {
  __toESM
} from "./chunk-SNAQBZPT.js";

// node_modules/@radix-ui/react-use-previous/dist/index.mjs
var React = __toESM(require_react(), 1);
function usePrevious(value) {
  const ref = React.useRef({ value, previous: value });
  return React.useMemo(() => {
    if (ref.current.value !== value) {
      ref.current.previous = ref.current.value;
      ref.current.value = value;
    }
    return ref.current.previous;
  }, [value]);
}

export {
  usePrevious
};
//# sourceMappingURL=chunk-TV6M7PIP.js.map
