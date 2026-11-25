//! Cross-platform input box types.
//!
//! On desktop/mobile this re-exports the `inputbox` crate. On wasm32 the
//! native dialog backends are unavailable, so a tiny builder-compatible shim
//! is used and the actual text is collected through the page's `prompt()`.

#[cfg(not(target_arch = "wasm32"))]
pub use inputbox::{InputBox, InputMode};

#[cfg(target_arch = "wasm32")]
mod web {
    #[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
    pub enum InputMode {
        #[default]
        Text,
        Password,
        Multiline,
    }

    #[derive(Debug, Default, Clone)]
    pub struct InputBox {
        pub default_text: String,
        pub title: Option<String>,
        pub prompt: Option<String>,
        pub cancel_label: Option<String>,
        pub ok_label: Option<String>,
        pub placeholder: Option<String>,
        pub mode: InputMode,
    }

    impl InputBox {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn default_text(mut self, text: impl Into<String>) -> Self {
            self.default_text = text.into();
            self
        }

        pub fn title(mut self, title: impl Into<String>) -> Self {
            self.title = Some(title.into());
            self
        }

        pub fn prompt(mut self, prompt: impl Into<String>) -> Self {
            self.prompt = Some(prompt.into());
            self
        }

        pub fn cancel_label(mut self, label: impl Into<String>) -> Self {
            self.cancel_label = Some(label.into());
            self
        }

        pub fn ok_label(mut self, label: impl Into<String>) -> Self {
            self.ok_label = Some(label.into());
            self
        }

        pub fn placeholder(mut self, placeholder: impl Into<String>) -> Self {
            self.placeholder = Some(placeholder.into());
            self
        }

        pub fn mode(mut self, mode: InputMode) -> Self {
            self.mode = mode;
            self
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use web::{InputBox, InputMode};
