const field = (key, label, type = "text", extra = {}) => ({
  key,
  label,
  type,
  ...extra,
});
const select = (key, label, options, extra) =>
  field(key, label, "select", { options, ...extra });
const bool = (key, label, extra) =>
  select(
    key,
    label,
    [
      [true, "statusOn"],
      [false, "statusOff"],
    ],
    { boolean: true, ...extra },
  );
const number = (key, label, min, max, step = 1, extra) =>
  field(key, label, "number", { min, max, step, ...extra });
const wm = (d) => d.watermark_enable;
const textWm = (d) => wm(d) && d.watermark_type !== "image";
export const schemas = {
  general: [
    select("card_copy_format", "cardCopyFormat", [
      ["raw", "rawLink"],
      ["webp", "webpLink"],
      ["markdown_raw", "markdownRaw"],
      ["markdown_webp", "markdownWebp"],
    ]),
    field("site_name", "lblSiteName", "text", { required: true }),
    field("base_url", "lblBaseUrl", "url", { required: true }),
    number("port", "lblPort", 1, 65535),
    field("raw_secret_path", "lblRawSecretPath", "text", { required: true }),
    field("pub_secret_path", "lblPubSecretPath", "text", { required: true }),
  ],
  security: [
    field("username", "lblUsername", "text", { required: true }),
    field("password", "loginPassword", "password"),
    field("admin_path", "lblAdminPath", "text", { required: true }),
    number("max_login_attempts", "lblMaxLoginAttempts", 1, 100),
    field("api_token", "lblApiToken", "password"),

  ],
  media: [
    bool("enable_optimization", "lblEnableOptimization"),
    number("webp_quality", "lblWebpQuality", 10, 100, 1, {
      when: (d) => d.enable_optimization,
    }),
    number("max_width", "lblMaxWidth", 0, 100000, 1, {
      when: (d) => d.enable_optimization,
    }),
    bool("watermark_enable", "lblWatermarkEnable"),
    select(
      "watermark_type",
      "lblWatermarkType",
      [
        ["image", "optWatermarkImg"],
        ["text", "optWatermarkText"],
        ["tile", "optWatermarkTile"],
      ],
      { when: wm },
    ),
    bool("watermark_auto_contrast", "lblWatermarkAutoContrast", { when: wm }),
    field("watermark_image", "lblWatermarkImageLight", "text", {
      when: (d) => wm(d) && d.watermark_type === "image",
    }),
    field("watermark_image_dark", "lblWatermarkImageDark", "text", {
      when: (d) =>
        wm(d) && d.watermark_type === "image" && d.watermark_auto_contrast,
    }),
    field("watermark_text", "lblWatermarkText", "text", { when: textWm }),
    select(
      "watermark_font",
      "lblWatermarkFont",
      [
        ["system", "optFontSystem"],
        ["pingfang", "optFontPingfang"],
        ["arial", "optFontArial"],
        ["impact", "optFontImpact"],
        ["georgia", "optFontGeorgia"],
        ["courier", "optFontCourier"],
      ],
      { when: textWm },
    ),
    field("watermark_color", "lblWatermarkColorLight", "text", {
      when: textWm,
    }),
    field("watermark_color_dark", "lblWatermarkColorDark", "text", {
      when: (d) => textWm(d) && d.watermark_auto_contrast,
    }),
    select(
      "watermark_pos",
      "lblWatermarkPos",
      [
        ["bottom-right", "optPosBottomRight"],
        ["bottom-left", "optPosBottomLeft"],
        ["top-right", "optPosTopRight"],
        ["top-left", "optPosTopLeft"],
        ["center", "optPosCenter"],
      ],
      { when: wm },
    ),
    number("watermark_scale", "lblWatermarkScale", 0.01, 1, 0.01, { when: wm }),
    number("watermark_opacity", "lblWatermarkOpacity", 0.1, 1, 0.01, {
      when: wm,
    }),
    number("watermark_margin", "lblWatermarkMargin", 0, 10000, 1, { when: wm }),
    number("watermark_min_width", "lblWatermarkMinWidth", 0, 100000, 1, {
      when: wm,
    }),
  ],
  backup: [
    bool("enabled", "lblBackupEnabled"),
    select("frequency", "lblBackupFrequency", [
      ["daily", "optFreqDaily"],
      ["hourly_12", "optFreq12h"],
      ["hourly_6", "optFreq6h"],
      ["hourly_4", "optFreq4h"],
      ["hourly_2", "optFreq2h"],
      ["hourly_1", "optFreqHourly"],
      ["interval_2d", "optFreq2d"],
      ["interval_3d", "optFreq3d"],
      ["weekly", "optFreqWeekly"],
      ["monthly", "optFreqMonthly"],
      ["cron", "optFreqCron"],
    ]),
    field("schedule", "lblBackupBaseTime", "time", {
      when: (d) => d.frequency !== "cron",
      required: true,
    }),
    select(
      "weekday",
      "lblWeekday",
      [
        "weekdaySun",
        "weekdayMon",
        "weekdayTue",
        "weekdayWed",
        "weekdayThu",
        "weekdayFri",
        "weekdaySat",
      ].map((label, i) => [i, label]),
      { numeric: true, when: (d) => d.frequency === "weekly" },
    ),
    number("monthday", "lblMonthday", 1, 31, 1, {
      when: (d) => d.frequency === "monthly",
    }),
    field("cron_expression", "lblCronExpression", "text", {
      when: (d) => d.frequency === "cron",
      required: true,
    }),
    number("retention", "lblBackupRetention", 1, 100),
    field("local_dir", "lblBackupLocalDir", "text", { required: true }),
    field("rclone_target", "lblBackupRclone"),
    field("bark_url", "lblBackupBark", "password"),
  ],
  updates: [
    bool("mirror_enabled", "enableUpdateProxy"),
    select("mirror_preset", "mirrorSource", [
      ["", "mirrorDirect"],
      ["https://ghproxy.net/", "ghproxy.net"],
      ["https://gh-proxy.com/", "gh-proxy.com"],
      ["https://mirror.ghproxy.com/", "mirror.ghproxy.com"],
      ["custom", "mirrorCustom"],
    ]),
    field("upstream_mirror", "mirrorUrl", "url", {
      when: (d) => d.mirror_preset === "custom",
    }),
  ],
};
schemas.compression = schemas.media.filter(
  (def) => !def.key.startsWith("watermark_"),
);
schemas.watermark = schemas.media.filter((def) =>
  def.key.startsWith("watermark_"),
);
schemas.site = [...schemas.general, ...schemas.security];
export function sectionValues(name, cfg) {
  const source = ["media", "compression", "watermark"].includes(name)
    ? cfg.image_host
    : name === "backup"
      ? cfg.backup
      : cfg;
  const result = Object.fromEntries(
    (schemas[name] || []).map(({ key, type, boolean, numeric, options }) => [
      key,
      source?.[key] ??
        (boolean
          ? false
          : type === "number"
            ? 0
            : numeric
              ? 0
              : (options?.[0]?.[0] ?? "")),
    ]),
  );
  if (["general", "site"].includes(name))
    Object.assign(result, {
      raw_secret_path: cfg.image_host.raw_secret_path,
      pub_secret_path: cfg.image_host.pub_secret_path,
      card_copy_format: cfg.console?.card_copy_format || "raw",
    });
  if (name === "updates") {
    result.mirror_enabled = Boolean(cfg.upstream_mirror);
    result.mirror_preset = !cfg.upstream_mirror ? "https://ghproxy.net/" : [
      "https://ghproxy.net/", "https://gh-proxy.com/", "https://mirror.ghproxy.com/",
    ].includes(cfg.upstream_mirror) ? cfg.upstream_mirror : "custom";
  }
  if (["security", "site"].includes(name))
    Object.assign(result, {password: "", api_token: ""});
  return result;
}
export function sectionPatch(name, values) {
  const allowed = Object.fromEntries(
    schemas[name].map(({ key }) => [key, values[key]]),
  );
  if (["media", "compression", "watermark"].includes(name))
    return { image_host: allowed };
  if (name === "backup") return { backup: allowed };
  if (["general", "site"].includes(name)) {
    const { raw_secret_path, pub_secret_path, card_copy_format, ...base } =
      allowed;
    if (!base.password) delete base.password;
    if (!base.api_token) delete base.api_token;
    return {
      ...base,
      console: { card_copy_format },
      image_host: { raw_secret_path, pub_secret_path },
    };
  }
  if (name === "security") {
    const base = { ...allowed };
    if (!base.password) delete base.password;
    if (!base.api_token) delete base.api_token;
    return base;
  }
  if (name === "updates")
    return {
      upstream_mirror: allowed.mirror_enabled === false ? "" :
        allowed.mirror_preset === "custom"
          ? allowed.upstream_mirror
          : allowed.mirror_preset,
    };
  return allowed;
}
