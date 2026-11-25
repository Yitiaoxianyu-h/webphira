use crate::scene::TEX_ICON_BACK;
use anyhow::Result;
use macroquad::texture::load_texture;
use prpr::ext::SafeTexture;

pub struct Icons {
    pub icon: SafeTexture,
    pub play: SafeTexture,
    pub medal: SafeTexture,
    pub respack: SafeTexture,
    pub msg: SafeTexture,
    pub settings: SafeTexture,
    pub back: SafeTexture,
    pub lang: SafeTexture,
    pub download: SafeTexture,
    pub user: SafeTexture,
    pub info: SafeTexture,
    pub delete: SafeTexture,
    pub menu: SafeTexture,
    pub edit: SafeTexture,
    pub ldb: SafeTexture,
    pub close: SafeTexture,
    pub search: SafeTexture,
    pub order: SafeTexture,
    pub filter: SafeTexture,
    pub r#mod: SafeTexture,
    pub star: SafeTexture,
    pub star_outline: SafeTexture,
    pub heart: SafeTexture,
    pub heart_outline: SafeTexture,
    pub cloud_none: SafeTexture,
    pub cloud_check: SafeTexture,
    pub plus: SafeTexture,
    pub select: SafeTexture,
    pub export: SafeTexture,

    #[cfg(feature = "hykb")]
    pub hykb: SafeTexture,

    pub r#abstract: SafeTexture,
}

impl Icons {
    pub async fn new() -> Result<Self> {
        // 所有图标一次性并发请求。原来是每个字段 `load_texture(...).await`，
        // 浏览器里就变成一张接一张串行下载（前一张下完才发下一个请求）。
        let mut futs = Vec::new();
        futs.push(load_texture("icon.png"));
        futs.push(load_texture("resume.png"));
        futs.push(load_texture("medal.png"));
        futs.push(load_texture("respack.png"));
        futs.push(load_texture("message.png"));
        futs.push(load_texture("settings.png"));
        futs.push(load_texture("language.png"));
        futs.push(load_texture("download.png"));
        futs.push(load_texture("user.png"));
        futs.push(load_texture("info.png"));
        futs.push(load_texture("delete.png"));
        futs.push(load_texture("menu.png"));
        futs.push(load_texture("edit.png"));
        futs.push(load_texture("leaderboard.png"));
        futs.push(load_texture("close.png"));
        futs.push(load_texture("search.png"));
        futs.push(load_texture("order.png"));
        futs.push(load_texture("filter.png"));
        futs.push(load_texture("mod.png"));
        futs.push(load_texture("star.png"));
        futs.push(load_texture("star_outline.png"));
        futs.push(load_texture("heart.png"));
        futs.push(load_texture("heart_outline.png"));
        futs.push(load_texture("cloud_none.png"));
        futs.push(load_texture("cloud_check.png"));
        futs.push(load_texture("plus.png"));
        futs.push(load_texture("select.png"));
        futs.push(load_texture("export.png"));
        #[cfg(feature = "hykb")]
        futs.push(load_texture("hykb.png"));
        futs.push(load_texture("abstract.jpg"));

        let mut tex = futures_util::future::try_join_all(futs).await?.into_iter();
        macro_rules! next {
            () => {
                tex.next().expect("icon count mismatch").into()
            };
        }

        Ok(Self {
            icon: next!(),
            play: next!(),
            medal: next!(),
            respack: next!(),
            msg: next!(),
            settings: next!(),
            lang: next!(),
            back: TEX_ICON_BACK.with(|it| it.borrow().clone().unwrap()),
            download: next!(),
            user: next!(),
            info: next!(),
            delete: next!(),
            menu: next!(),
            edit: next!(),
            ldb: next!(),
            close: next!(),
            search: next!(),
            order: next!(),
            filter: next!(),
            r#mod: next!(),
            star: next!(),
            star_outline: next!(),
            heart: next!(),
            heart_outline: next!(),
            cloud_none: next!(),
            cloud_check: next!(),
            plus: next!(),
            select: next!(),
            export: next!(),

            #[cfg(feature = "hykb")]
            hykb: next!(),

            r#abstract: next!(),
        })
    }
}
