/* global React, ReactDOM, ZhKeyboardReact */

(async function bootstrapKeyboard() {
  try {
    const bootIndicator = document.getElementById("keyboard-boot");
    const params = new URLSearchParams(window.location.search);
    const isEmbedded = params.get("embedded") === "1";
    const embeddedBottomInset = Number.parseInt(params.get("bottomInset") || "0", 10);
    const safeBottomInset = Number.isFinite(embeddedBottomInset) ? Math.max(embeddedBottomInset, 0) : 0;
    const { RimePinyinEngine } = await import("/vendor/zh-keyboard-pinyin.mjs");
    const { useCallback, useMemo, useState } = React;
    const { ZhKeyboard, registerPinyinEngine, setKeyboardConfig } = ZhKeyboardReact;
    const pinyinEngine = new RimePinyinEngine({
      wasmDir: "/vendor/pinyin-data",
      simplified: true,
    });

    registerPinyinEngine(pinyinEngine);

    setKeyboardConfig({
      defaultMode: "zh",
      position: "static",
    });

    const postBridgeMessage = (payload) => {
      const message = JSON.stringify(payload);

      if (
        window.ReactNativeWebView &&
        typeof window.ReactNativeWebView.postMessage === "function"
      ) {
        window.ReactNativeWebView.postMessage(message);
        return;
      }

      if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, "*");
      }
    };

    const CONTROL_INPUT_MAP = {
      delete: "\u007f",
      enter: "\r",
    };

    function App() {
      const [previewText, setPreviewText] = useState("");
      const [lastAction, setLastAction] = useState("输入会实时发送到终端");
      const [isSimplified, setIsSimplified] = useState(true);

      const previewPlaceholder = useMemo(
        () => "点下面中文键盘直接输入，内容会实时发送到终端。",
        []
      );

      const toggleChineseVariant = useCallback(() => {
        const next = !isSimplified;

        pinyinEngine.setSimplified(next).catch((error) => {
          console.error("切换简繁失败:", error);
          setLastAction("简繁切换失败，请重试");
        });
        setIsSimplified(next);
        setLastAction(next ? "已切换为简体输入" : "已切换为繁體輸入");
      }, [isSimplified]);

      const handleKey = useCallback((event) => {
        if (!event || typeof event.key !== "string") {
          return;
        }

        const rawText = CONTROL_INPUT_MAP[event.key] ?? event.key;
        if (!rawText) {
          return;
        }

        postBridgeMessage({
          type: "keyboard_input",
          text: rawText,
          key: event.key,
          isControl: Boolean(event.isControl),
        });

        if (event.key === "enter") {
          setPreviewText("");
          setLastAction("已发送回车");
        } else if (event.key === "delete") {
          setLastAction("已发送删除");
        } else {
          setLastAction(`已发送: ${event.key}`);
        }
      }, []);

      const closeKeyboard = useCallback(() => {
        postBridgeMessage({ type: "keyboard_close" });
      }, []);

      return React.createElement(
        "div",
        {
          className: isEmbedded
            ? "firefly-keyboard-page firefly-keyboard-page--embedded"
            : "firefly-keyboard-page",
          style: isEmbedded ? styles.pageEmbedded : styles.page,
        },
        !isEmbedded &&
          React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "div",
              { style: styles.header },
              React.createElement("div", null, [
                React.createElement(
                  "div",
                  { key: "title", style: styles.title },
                  "中文屏幕键盘"
                ),
                React.createElement(
                  "div",
                  { key: "subtitle", style: styles.subtitle },
                  lastAction
                ),
              ]),
              React.createElement(
                "button",
                {
                  type: "button",
                  onClick: toggleChineseVariant,
                  style: {
                    ...styles.variantToggleButton,
                    ...(!isSimplified ? styles.variantToggleButtonActive : null),
                  },
                },
                isSimplified ? "简体" : "繁體"
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  onClick: closeKeyboard,
                  style: styles.closeButton,
                },
                "关闭"
              )
            ),
            React.createElement(
              "div",
              { style: styles.previewWrap },
              React.createElement("div", { style: styles.previewLabel }, "本地预览"),
              React.createElement("input", {
                value: previewText,
                onChange: (event) => setPreviewText(event.target.value),
                placeholder: previewPlaceholder,
                inputMode: "none",
                "data-inputmode": "zh",
                style: styles.previewInput,
              })
            )
          ),
        isEmbedded &&
          React.createElement(
            "div",
            { style: styles.embeddedStatusBar },
            React.createElement(
              "button",
              {
                type: "button",
                onClick: toggleChineseVariant,
                style: {
                  ...styles.variantToggleButton,
                  ...styles.embeddedVariantToggleButton,
                  ...(!isSimplified ? styles.variantToggleButtonActive : null),
                },
              },
              isSimplified ? "简体" : "繁體"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                onClick: closeKeyboard,
                style: styles.embeddedCloseButton,
              },
              "收起"
            )
          ),
        React.createElement(ZhKeyboard, {
          key: isSimplified ? "zh-simplified" : "zh-traditional",
          value: previewText,
          onChange: setPreviewText,
          defaultMode: "zh",
          position: "static",
          disableWhenNoFocus: false,
          onKey: handleKey,
          style: styles.keyboard,
        }),
        isEmbedded &&
          React.createElement("div", {
            style: {
              flex: "0 0 auto",
              height: `${safeBottomInset}px`,
              background: "#1f1f1f",
            },
          })
      );
    }

    const styles = {
      page: {
        width: "100vw",
        minWidth: "100vw",
        maxWidth: "100vw",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        background: "#1f1f1f",
        overflow: "hidden",
      },
      pageEmbedded: {
        width: "100vw",
        minWidth: "100vw",
        maxWidth: "100vw",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        background: "#1f1f1f",
        paddingTop: "8px",
        paddingBottom: "0px",
        overflow: "hidden",
      },
      header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "12px 14px 10px",
        borderBottom: "1px solid #2d2d2d",
        background: "#252525",
      },
      title: {
        fontSize: "16px",
        fontWeight: 700,
        lineHeight: 1.2,
        color: "#ffffff",
      },
      subtitle: {
        marginTop: "4px",
        fontSize: "12px",
        color: "#8d8d8d",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "260px",
      },
      closeButton: {
        border: "none",
        borderRadius: "999px",
        background: "#3a3a3a",
        color: "#ffffff",
        padding: "8px 14px",
        fontSize: "13px",
        fontWeight: 600,
      },
      variantToggleButton: {
        border: "1px solid #454545",
        borderRadius: "999px",
        background: "#2f2f2f",
        color: "#f2f2f2",
        padding: "8px 12px",
        marginRight: "8px",
        fontSize: "13px",
        fontWeight: 700,
        minWidth: "58px",
      },
      variantToggleButtonActive: {
        borderColor: "#19c37d",
        background: "#0f6b46",
        color: "#ffffff",
      },
      embeddedStatusBar: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 12px 8px",
      },
      embeddedVariantToggleButton: {
        padding: "7px 12px",
        fontSize: "12px",
      },
      embeddedCloseButton: {
        border: "none",
        borderRadius: "999px",
        background: "#323232",
        color: "#ffffff",
        padding: "7px 12px",
        fontSize: "12px",
        fontWeight: 600,
      },
      previewWrap: {
        padding: "12px 14px 10px",
        background: "#1f1f1f",
      },
      previewLabel: {
        marginBottom: "6px",
        color: "#8d8d8d",
        fontSize: "12px",
        fontWeight: 600,
      },
      previewInput: {
        width: "100%",
        minHeight: "42px",
        border: "1px solid #303030",
        borderRadius: "10px",
        padding: "10px 12px",
        background: "#121212",
        color: "#ffffff",
        outline: "none",
      },
      keyboard: {
        width: "100vw",
        minWidth: "100vw",
        maxWidth: "100vw",
        margin: 0,
        alignSelf: "stretch",
        borderRadius: isEmbedded ? "16px 16px 0 0" : "12px",
        boxShadow: isEmbedded ? "none" : undefined,
      },
    };

    const root = ReactDOM.createRoot(document.getElementById("root"));
    if (bootIndicator) {
      bootIndicator.style.display = "none";
    }
    root.render(React.createElement(App));
  } catch (error) {
    if (typeof window.__showKeyboardError === "function") {
      window.__showKeyboardError(error && error.stack ? error.stack : error);
    }
    throw error;
  }
})();
