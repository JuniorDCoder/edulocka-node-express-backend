// ============================================================================
// Blog Controller — Blog CRUD + moderation workflow
// ============================================================================

const crypto = require("crypto");
const mongoose = require("mongoose");

const BlogPost = require("../models/BlogPost");
const BlogAuditLog = require("../models/BlogAuditLog");
const blockchainService = require("../services/blockchainService");
const { isAdminWallet } = require("../middleware/adminMiddleware");

const MAX_PAGE_SIZE = 24;
const MAX_LOG_PAGE_SIZE = 50;

function ensureMongoConnected(res) {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      error: "Database unavailable. Ensure MongoDB is connected before using blog features.",
    });
    return false;
  }
  return true;
}

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(String(query.page || "1"), 10) || 1);
  const rawLimit = parseInt(String(query.limit || "12"), 10) || 12;
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, rawLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function normalizeTags(input) {
  let arr = [];
  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === "string") {
    arr = input.split(",");
  }

  const uniq = new Set();
  for (const raw of arr) {
    const tag = String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9- ]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (tag) uniq.add(tag);
  }

  return Array.from(uniq).slice(0, 12);
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (slug) return slug;
  return `blog-${Date.now()}`;
}

async function generateUniqueSlug(title, ignoreId = null) {
  const base = slugify(title);
  let slug = base;
  let i = 1;

  while (true) {
    const query = ignoreId ? { slug, _id: { $ne: ignoreId } } : { slug };
    const exists = await BlogPost.exists(query);
    if (!exists) return slug;
    i += 1;
    slug = `${base}-${i}`;
  }
}

function stripMarkdown(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ")
    .replace(/[#>*_\-\[\]\(\)!~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveExcerpt(markdown, maxLen = 180) {
  const plain = stripMarkdown(markdown);
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen).trim()}...`;
}

function estimateReadTime(markdown) {
  const plain = stripMarkdown(markdown);
  const words = plain ? plain.split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / 220));
}

function normalizeCoverImageUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("ipfs://")) {
    return value;
  }
  return "";
}

function buildContentHash(payload) {
  const canonical = JSON.stringify({
    title: payload.title || "",
    excerpt: payload.excerpt || "",
    contentMarkdown: payload.contentMarkdown || "",
    coverImageUrl: payload.coverImageUrl || "",
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    authorWallet: payload.authorWallet || "",
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function responseFromBlog(post, opts = {}) {
  const includeContent = opts.includeContent !== false;
  const isOwner = Boolean(opts.isOwner);
  const isAdmin = Boolean(opts.isAdmin);

  return {
    id: String(post._id),
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    contentMarkdown: includeContent ? post.contentMarkdown : undefined,
    coverImageUrl: post.coverImageUrl || "",
    tags: post.tags || [],
    status: post.status,
    readTimeMinutes: post.readTimeMinutes || 1,
    contentHash: post.contentHash,
    author: {
      wallet: post.authorWallet,
      displayName: post.authorDisplayName || "",
    },
    moderation: isOwner || isAdmin
      ? {
          reviewNote: post.reviewNote || "",
          reviewedBy: post.reviewedBy || null,
          reviewedAt: post.reviewedAt || null,
        }
      : undefined,
    chainAnchor: post.chainAnchor && (post.chainAnchor.blockNumber || post.chainAnchor.anchorError)
      ? {
          chainId: post.chainAnchor.chainId,
          chainName: post.chainAnchor.chainName,
          blockNumber: post.chainAnchor.blockNumber,
          blockHash: post.chainAnchor.blockHash,
          anchoredAt: post.chainAnchor.anchoredAt,
          anchorError: (isOwner || isAdmin) ? post.chainAnchor.anchorError || "" : undefined,
        }
      : null,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    lastEditedAt: post.lastEditedAt,
    publishedAt: post.publishedAt,
    permissions: {
      isOwner,
      isAdmin,
      canEdit: isOwner || isAdmin,
      canDelete: isOwner || isAdmin,
      canReview: isAdmin,
    },
  };
}

function requesterFlags(req, post = null) {
  const requesterWallet = String(req.walletAddress || req.adminAddress || "").toLowerCase();
  const requesterIsAdmin = requesterWallet ? isAdminWallet(requesterWallet) : false;
  const requesterIsOwner =
    post && requesterWallet
      ? String(post.authorWallet || "").toLowerCase() === requesterWallet
      : false;

  return {
    requesterWallet,
    requesterIsAdmin,
    requesterIsOwner,
  };
}

async function writeBlogAuditLog({
  blogId = null,
  blogTitle = "",
  blogSlug = "",
  action,
  actorWallet,
  actorRole,
  note = "",
  statusBefore = null,
  statusAfter = null,
  metadata = {},
}) {
  if (mongoose.connection.readyState !== 1) return;

  try {
    await BlogAuditLog.create({
      blogId,
      blogTitle,
      blogSlug,
      action,
      actorWallet: String(actorWallet || "").toLowerCase(),
      actorRole,
      note: String(note || "").trim().slice(0, 1000),
      statusBefore,
      statusAfter,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    });
  } catch (err) {
    // Logging failures should never block core blog operations.
    console.error("Blog audit log write failed:", err.message);
  }
}

// GET /api/blogs
async function listPublishedBlogs(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const { page, limit, skip } = parsePagination(req.query);
    const search = String(req.query.search || "").trim();
    const tag = String(req.query.tag || "").trim().toLowerCase();

    const query = { status: "published" };
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { excerpt: { $regex: search, $options: "i" } },
        { tags: { $regex: search, $options: "i" } },
      ];
    }
    if (tag) {
      query.tags = tag;
    }

    const [posts, total] = await Promise.all([
      BlogPost.find(query)
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-contentMarkdown -reviewNote -reviewedBy -reviewedAt")
        .lean(),
      BlogPost.countDocuments(query),
    ]);

    res.json({
      blogs: posts.map((post) => responseFromBlog(post, { includeContent: false })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/blogs/:slug
async function getPublishedBlog(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const slug = String(req.params.slug || "").toLowerCase().trim();
    if (!slug) return res.status(400).json({ error: "Missing blog slug" });

    const post = await BlogPost.findOne({ slug, status: "published" }).lean();
    if (!post) {
      return res.status(404).json({ error: "Blog post not found" });
    }

    res.json({ blog: responseFromBlog(post, { includeContent: true }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/blogs/my
async function listMyBlogs(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const wallet = String(req.walletAddress || "").toLowerCase();
    const { page, limit, skip } = parsePagination(req.query);
    const status = String(req.query.status || "").trim();
    const search = String(req.query.search || "").trim();

    const query = { authorWallet: wallet };
    if (status && ["draft", "pending_review", "published", "rejected"].includes(status)) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { excerpt: { $regex: search, $options: "i" } },
      ];
    }

    const [posts, total] = await Promise.all([
      BlogPost.find(query)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BlogPost.countDocuments(query),
    ]);

    res.json({
      blogs: posts.map((post) => responseFromBlog(post, {
        includeContent: false,
        isOwner: true,
        isAdmin: isAdminWallet(wallet),
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/blogs/my/:id
async function getMyBlogById(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const id = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog ID" });
    }

    const post = await BlogPost.findById(id).lean();
    if (!post) return res.status(404).json({ error: "Blog post not found" });

    const { requesterIsAdmin, requesterIsOwner } = requesterFlags(req, post);
    if (!requesterIsOwner && !requesterIsAdmin) {
      return res.status(403).json({ error: "You can only access your own blog posts" });
    }

    res.json({
      blog: responseFromBlog(post, {
        includeContent: true,
        isOwner: requesterIsOwner,
        isAdmin: requesterIsAdmin,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/blogs
async function createBlog(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const authorWallet = String(req.walletAddress || "").toLowerCase();
    const title = String(req.body.title || "").trim();
    const rawContent = String(req.body.contentMarkdown || "");
    const contentMarkdown = rawContent.trim();
    const excerptInput = String(req.body.excerpt || "").trim();
    const coverImageUrl = normalizeCoverImageUrl(req.body.coverImageUrl);
    const tags = normalizeTags(req.body.tags);
    const authorDisplayName = String(req.body.authorDisplayName || "").trim();
    const requestedStatus = String(req.body.status || "").trim();

    if (title.length < 5) {
      return res.status(400).json({ error: "Title must be at least 5 characters long" });
    }
    if (contentMarkdown.length < 20) {
      return res.status(400).json({ error: "Content must be at least 20 characters long" });
    }

    const status = requestedStatus === "draft" ? "draft" : "pending_review";
    const excerpt = excerptInput || deriveExcerpt(contentMarkdown);
    const slug = await generateUniqueSlug(title);
    const readTimeMinutes = estimateReadTime(contentMarkdown);
    const contentHash = buildContentHash({
      title,
      excerpt,
      contentMarkdown,
      coverImageUrl,
      tags,
      authorWallet,
    });

    const post = await BlogPost.create({
      title,
      slug,
      excerpt,
      contentMarkdown,
      coverImageUrl,
      tags,
      authorWallet,
      authorDisplayName,
      status,
      readTimeMinutes,
      contentHash,
      lastEditedAt: new Date(),
    });

    await writeBlogAuditLog({
      blogId: post._id,
      blogTitle: post.title,
      blogSlug: post.slug,
      action: status === "draft" ? "create" : "submit_review",
      actorWallet: authorWallet,
      actorRole: "author",
      statusBefore: null,
      statusAfter: post.status,
      metadata: {
        tagsCount: post.tags.length,
        contentHash: post.contentHash,
      },
    });

    res.status(201).json({
      success: true,
      message: status === "draft" ? "Draft saved." : "Blog submitted for admin review.",
      blog: responseFromBlog(post.toObject(), { includeContent: true, isOwner: true }),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "A blog with this slug already exists. Try another title." });
    }
    res.status(500).json({ error: err.message });
  }
}

// PUT /api/blogs/:id
async function updateBlog(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const id = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog ID" });
    }

    const post = await BlogPost.findById(id);
    if (!post) return res.status(404).json({ error: "Blog post not found" });

    const { requesterIsOwner, requesterIsAdmin } = requesterFlags(req, post);
    if (!requesterIsOwner && !requesterIsAdmin) {
      return res.status(403).json({ error: "You can only edit your own blog posts" });
    }

    const statusBefore = post.status;
    const payload = {};
    let contentChanged = false;

    if (req.body.title !== undefined) {
      const title = String(req.body.title || "").trim();
      if (title.length < 5) {
        return res.status(400).json({ error: "Title must be at least 5 characters long" });
      }
      payload.title = title;
      if (title !== post.title) {
        payload.slug = await generateUniqueSlug(title, post._id);
        contentChanged = true;
      }
    }

    if (req.body.contentMarkdown !== undefined) {
      const contentMarkdown = String(req.body.contentMarkdown || "").trim();
      if (contentMarkdown.length < 20) {
        return res.status(400).json({ error: "Content must be at least 20 characters long" });
      }
      payload.contentMarkdown = contentMarkdown;
      if (contentMarkdown !== post.contentMarkdown) contentChanged = true;
    }

    if (req.body.excerpt !== undefined) {
      payload.excerpt = String(req.body.excerpt || "").trim().slice(0, 400);
      if (payload.excerpt !== post.excerpt) contentChanged = true;
    }

    if (req.body.coverImageUrl !== undefined) {
      payload.coverImageUrl = normalizeCoverImageUrl(req.body.coverImageUrl);
      if (payload.coverImageUrl !== post.coverImageUrl) contentChanged = true;
    }

    if (req.body.tags !== undefined) {
      payload.tags = normalizeTags(req.body.tags);
      if (JSON.stringify(payload.tags) !== JSON.stringify(post.tags || [])) {
        contentChanged = true;
      }
    }

    if (!payload.excerpt && payload.contentMarkdown) {
      payload.excerpt = deriveExcerpt(payload.contentMarkdown);
    } else if (req.body.excerpt === "" && (payload.contentMarkdown || post.contentMarkdown)) {
      payload.excerpt = deriveExcerpt(payload.contentMarkdown || post.contentMarkdown);
    }

    if (req.body.authorDisplayName !== undefined && (requesterIsOwner || requesterIsAdmin)) {
      payload.authorDisplayName = String(req.body.authorDisplayName || "").trim().slice(0, 80);
    }

    if (req.body.status !== undefined) {
      const requestedStatus = String(req.body.status || "").trim();
      if (requesterIsAdmin) {
        if (["draft", "pending_review", "published", "rejected"].includes(requestedStatus)) {
          payload.status = requestedStatus;
        }
      } else if (["draft", "pending_review"].includes(requestedStatus)) {
        payload.status = requestedStatus;
      }
    }

    // If a published/rejected post is edited by the author, force moderation again
    if (requesterIsOwner && contentChanged) {
      if (payload.status !== "draft") {
        payload.status = "pending_review";
      }
      payload.reviewNote = "";
      payload.reviewedBy = null;
      payload.reviewedAt = null;
      payload.publishedAt = null;
      payload.chainAnchor = {
        chainId: null,
        chainName: null,
        blockNumber: null,
        blockHash: null,
        anchoredAt: null,
        anchorError: "",
      };
    }

    const nextState = {
      title: payload.title ?? post.title,
      excerpt: payload.excerpt ?? post.excerpt,
      contentMarkdown: payload.contentMarkdown ?? post.contentMarkdown,
      coverImageUrl: payload.coverImageUrl ?? post.coverImageUrl,
      tags: payload.tags ?? post.tags,
      authorWallet: post.authorWallet,
    };

    payload.readTimeMinutes = estimateReadTime(nextState.contentMarkdown);
    payload.contentHash = buildContentHash(nextState);
    payload.lastEditedAt = new Date();

    Object.assign(post, payload);
    await post.save();

    const flags = requesterFlags(req, post);
    await writeBlogAuditLog({
      blogId: post._id,
      blogTitle: post.title,
      blogSlug: post.slug,
      action: post.status === "pending_review" && statusBefore !== "pending_review" ? "submit_review" : "update",
      actorWallet: flags.requesterWallet,
      actorRole: flags.requesterIsAdmin ? "admin" : "author",
      statusBefore,
      statusAfter: post.status,
      metadata: {
        contentChanged,
        tagsCount: (post.tags || []).length,
        contentHash: post.contentHash,
      },
    });

    res.json({
      success: true,
      message: post.status === "pending_review"
        ? "Blog updated and submitted for review."
        : "Blog updated successfully.",
      blog: responseFromBlog(post.toObject(), {
        includeContent: true,
        isOwner: flags.requesterIsOwner,
        isAdmin: flags.requesterIsAdmin,
      }),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "A blog with this slug already exists. Try another title." });
    }
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/blogs/:id
async function deleteBlog(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const id = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog ID" });
    }

    const post = await BlogPost.findById(id).lean();
    if (!post) return res.status(404).json({ error: "Blog post not found" });

    const { requesterIsOwner, requesterIsAdmin } = requesterFlags(req, post);
    if (!requesterIsOwner && !requesterIsAdmin) {
      return res.status(403).json({ error: "You can only delete your own blog posts" });
    }

    await BlogPost.deleteOne({ _id: id });
    await writeBlogAuditLog({
      blogId: post._id,
      blogTitle: post.title,
      blogSlug: post.slug,
      action: "delete",
      actorWallet: String(req.walletAddress || req.adminAddress || "").toLowerCase(),
      actorRole: requesterIsAdmin ? "admin" : "author",
      statusBefore: post.status,
      statusAfter: null,
      note: String(req.body?.reason || "").trim(),
    });
    res.json({ success: true, message: "Blog post deleted." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/blogs/pending-review
async function listPendingReviewBlogs(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const { page, limit, skip } = parsePagination(req.query);
    const search = String(req.query.search || "").trim();

    const query = { status: "pending_review" };
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { excerpt: { $regex: search, $options: "i" } },
        { authorWallet: { $regex: search, $options: "i" } },
      ];
    }

    const [posts, total] = await Promise.all([
      BlogPost.find(query)
        .sort({ updatedAt: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BlogPost.countDocuments(query),
    ]);

    res.json({
      blogs: posts.map((post) => responseFromBlog(post, {
        includeContent: false,
        isAdmin: true,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/admin/blogs
async function listBlogsForAdmin(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const { page, limit, skip } = parsePagination(req.query);
    const status = String(req.query.status || "").trim();
    const search = String(req.query.search || "").trim();

    const query = {};
    if (status && ["draft", "pending_review", "published", "rejected"].includes(status)) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { excerpt: { $regex: search, $options: "i" } },
        { authorWallet: { $regex: search, $options: "i" } },
        { tags: { $regex: search, $options: "i" } },
      ];
    }

    const [posts, total] = await Promise.all([
      BlogPost.find(query)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BlogPost.countDocuments(query),
    ]);

    res.json({
      blogs: posts.map((post) =>
        responseFromBlog(post, {
          includeContent: false,
          isAdmin: true,
        })
      ),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      summary: {
        pendingReview: await BlogPost.countDocuments({ status: "pending_review" }),
        published: await BlogPost.countDocuments({ status: "published" }),
        drafts: await BlogPost.countDocuments({ status: "draft" }),
        rejected: await BlogPost.countDocuments({ status: "rejected" }),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/admin/blog-logs
async function listBlogAuditLogs(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const rawLimit = parseInt(String(req.query.limit || "20"), 10) || 20;
    const limit = Math.max(1, Math.min(MAX_LOG_PAGE_SIZE, rawLimit));
    const skip = (page - 1) * limit;

    const action = String(req.query.action || "").trim();
    const actor = String(req.query.actor || "").trim().toLowerCase();
    const blogId = String(req.query.blogId || "").trim();

    const query = {};
    if (action) query.action = action;
    if (actor) query.actorWallet = actor;
    if (blogId && mongoose.Types.ObjectId.isValid(blogId)) {
      query.blogId = new mongoose.Types.ObjectId(blogId);
    }

    const [logs, total] = await Promise.all([
      BlogAuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BlogAuditLog.countDocuments(query),
    ]);

    res.json({
      logs: logs.map((log) => ({
        id: String(log._id),
        blogId: log.blogId ? String(log.blogId) : null,
        blogTitle: log.blogTitle || "",
        blogSlug: log.blogSlug || "",
        action: log.action,
        actorWallet: log.actorWallet,
        actorRole: log.actorRole,
        note: log.note || "",
        statusBefore: log.statusBefore || null,
        statusAfter: log.statusAfter || null,
        metadata: log.metadata || {},
        createdAt: log.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/blogs/:id/review
// body: { action: "approve" | "reject", note?: string }
async function reviewBlog(req, res) {
  try {
    if (!ensureMongoConnected(res)) return;

    const id = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog ID" });
    }

    const action = String(req.body.action || "").trim().toLowerCase();
    const note = String(req.body.note || "").trim();
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ error: "Invalid review action. Use 'approve' or 'reject'." });
    }

    const post = await BlogPost.findById(id);
    if (!post) return res.status(404).json({ error: "Blog post not found" });

    const statusBefore = post.status;
    const now = new Date();
    post.reviewedBy = String(req.adminAddress || "").toLowerCase() || null;
    post.reviewedAt = now;
    post.reviewNote = note;

    if (action === "approve") {
      post.status = "published";
      post.publishedAt = now;

      const anchor = {
        chainId: null,
        chainName: null,
        blockNumber: null,
        blockHash: null,
        anchoredAt: now,
        anchorError: "",
      };

      try {
        const provider = blockchainService.getProvider();
        const [network, block] = await Promise.all([
          provider.getNetwork(),
          provider.getBlock("latest"),
        ]);
        anchor.chainId = Number(network.chainId);
        anchor.chainName = network.name || null;
        anchor.blockNumber = block ? Number(block.number) : null;
        anchor.blockHash = block ? block.hash : null;
      } catch (err) {
        anchor.anchorError = err.message || "Failed to fetch chain anchor data";
      }

      post.chainAnchor = anchor;
    } else {
      post.status = "rejected";
      post.publishedAt = null;
      post.chainAnchor = {
        chainId: null,
        chainName: null,
        blockNumber: null,
        blockHash: null,
        anchoredAt: null,
        anchorError: "",
      };
    }

    await post.save();

    await writeBlogAuditLog({
      blogId: post._id,
      blogTitle: post.title,
      blogSlug: post.slug,
      action: action === "approve" ? "approve" : "reject",
      actorWallet: String(req.adminAddress || "").toLowerCase(),
      actorRole: "admin",
      note,
      statusBefore,
      statusAfter: post.status,
      metadata: {
        chainAnchor: post.chainAnchor || null,
      },
    });

    res.json({
      success: true,
      message: action === "approve" ? "Blog approved and published." : "Blog rejected.",
      blog: responseFromBlog(post.toObject(), { includeContent: true, isAdmin: true }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  listPublishedBlogs,
  getPublishedBlog,
  listMyBlogs,
  getMyBlogById,
  createBlog,
  updateBlog,
  deleteBlog,
  listPendingReviewBlogs,
  listBlogsForAdmin,
  listBlogAuditLogs,
  reviewBlog,
};
