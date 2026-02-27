export interface VimeoFileLinks {
  progressiveMp4s: Array<{ quality: string; link: string; size?: number; height?: number }>;
  hasFilesField: boolean;
  hasDownloadField: boolean;
  rawPrivacy?: any;
}

export interface VimeoDiagnostic {
  code: "VIMEO_UNAUTHORIZED" | "VIMEO_NOT_FOUND" | "VIMEO_NO_DOWNLOAD_LINKS" | "VIMEO_API_ERROR";
  message: string;
  hints: string[];
}

export function vimeoExtractFileLinks(videoJson: any): VimeoFileLinks {
  const files: any[] = videoJson.files || [];
  const download: any[] = videoJson.download || [];

  const hasFilesField = "files" in videoJson;
  const hasDownloadField = "download" in videoJson;

  const mp4s: VimeoFileLinks["progressiveMp4s"] = [];

  // Parse from `files` array (progressive mp4 or HLS)
  for (const f of files) {
    if (f.type === "video/mp4" && f.link) {
      mp4s.push({ quality: f.quality || "unknown", link: f.link, size: f.size, height: f.height });
    }
    // Some plans expose progressive mp4 under quality property without type
    if (!f.type && f.link && f.quality && f.quality !== "hls") {
      mp4s.push({ quality: f.quality, link: f.link, size: f.size, height: f.height });
    }
  }

  // Parse from `download` array (download links)
  for (const d of download) {
    if (d.link && (d.type === "video/mp4" || !d.type)) {
      mp4s.push({ quality: d.quality || "unknown", link: d.link, size: d.size, height: d.height || d.size });
    }
  }

  // Sort by height descending (highest quality first)
  mp4s.sort((a, b) => (b.height || 0) - (a.height || 0));

  // Deduplicate by link
  const seen = new Set<string>();
  const deduped = mp4s.filter(m => {
    if (seen.has(m.link)) return false;
    seen.add(m.link);
    return true;
  });

  return {
    progressiveMp4s: deduped,
    hasFilesField,
    hasDownloadField,
    rawPrivacy: videoJson.privacy,
  };
}

export function vimeoDiagnoseNoFileAccess(videoJson: any, httpStatus: number): VimeoDiagnostic {
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      code: "VIMEO_UNAUTHORIZED",
      message: "Your Vimeo token is invalid or lacks the required permissions to access this video.",
      hints: [
        "Generate a Personal Access Token on Vimeo with scopes: public, private, video_files.",
        "Ensure the token belongs to the Vimeo account that owns this video.",
        "Update the token in System Settings → Vimeo Access Token.",
      ],
    };
  }

  if (httpStatus === 404) {
    return {
      code: "VIMEO_NOT_FOUND",
      message: "Video not found or not accessible with this token.",
      hints: [
        "Double-check the Vimeo video ID or URL.",
        "Ensure the video exists and is owned by, or shared with, the token account.",
      ],
    };
  }

  // Status 200 but no file links
  const privacy = videoJson?.privacy?.view || "unknown";
  const hasFilesKey = "files" in videoJson;
  const hasDownloadKey = "download" in videoJson;

  const hints: string[] = [];

  if (!hasFilesKey && !hasDownloadKey) {
    hints.push(
      "The API response does not include a 'files' or 'download' field — this usually means your token lacks the video_files scope or the account plan does not expose file links.",
      "Regenerate your Vimeo Personal Access Token and include the 'video_files' scope explicitly.",
    );
  } else if (hasDownloadKey) {
    hints.push("A 'download' field was present in the API response but contained no usable MP4 links.");
    hints.push("In your Vimeo video settings, check that 'Allow downloads' is enabled for this video.");
  }

  if (privacy === "password" || privacy === "nobody") {
    hints.push(`This video has privacy setting '${privacy}' — the API may hide file links for videos with restricted privacy.`);
  }

  hints.push("Ensure your token has the 'video_files' scope and that you are the owner of the video.");
  hints.push("Some Vimeo plans or account settings may restrict access to video files via API.");
  hints.push("Recommended: Upload the original video file directly to CMS for fully secure playback with your watermark and security settings.");

  return {
    code: "VIMEO_NO_DOWNLOAD_LINKS",
    message: "Vimeo did not expose any downloadable MP4 links for this video. This may be due to token permissions, video privacy settings, or account plan restrictions.",
    hints,
  };
}

export async function vimeoFetchVideo(vimeoVideoId: string, token: string): Promise<{ status: number; data: any }> {
  const apiRes = await fetch(`https://api.vimeo.com/videos/${vimeoVideoId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.vimeo.*+json;version=3.4",
    },
  });
  const data = await apiRes.json().catch(() => ({}));
  return { status: apiRes.status, data };
}
