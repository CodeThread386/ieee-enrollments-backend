import jwt from "jsonwebtoken";
import moment from "moment-timezone";
import mongoose from "mongoose";
import {
  baseCookieOptions,
  generateTokens,
  setCookies,
} from "../lib/auth.js";
import User from "../models/user.model.js";
import Admin from "../models/admin.model.js";
import Slot from "../models/slot.model.js";
import sendMail from "../lib/mail.js";

export const fetchAdminData = async (req, res) => {
  try {
    const admin = req.user;
    return res.status(200).json({
      success: true,
      data: {
        _id: admin._id,
        name: admin.name,
        email: admin.email,
        meetLink: admin.meetLink,
        access: admin.access,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const login = async (req, res) => {
  const { name, email } = req.user;
  const deviceId = req.body.deviceId;
  if (
    !email ||
    email.trim().length === 0 ||
    !name ||
    name.trim().length === 0
  ) {
    return res
      .status(400)
      .json({ success: false, message: "Email and name are required" });
  }
  if (!deviceId) {
    return res
      .status(400)
      .json({ success: false, message: "Device ID is required" });
  }
  const regNoIndex = name.lastIndexOf(" ");
  const adminName = name.slice(0, regNoIndex).trim();
  try {
    const currentAdmin = await Admin.findOne({ email });
    let admin;
    if (currentAdmin) {
      admin = currentAdmin;
    } else {
      admin = await Admin.create({ name: adminName, email });
    }
    const { accessToken, refreshToken } = generateTokens(admin._id);
    admin.refreshTokens = admin.refreshTokens || [];
    admin.refreshTokens = admin.refreshTokens.filter(
      (t) => t.deviceId !== deviceId
    );
    admin.refreshTokens.push({
      token: refreshToken,
      deviceId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    await admin.save();
    setCookies(res, accessToken, refreshToken);
    return res.status(currentAdmin ? 200 : 201).json({
      success: true,
      data: {
        _id: admin._id,
        name: admin.name,
        email: admin.email,
        meetLink: admin.meetLink,
        access: admin.access,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const logout = async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (refreshToken) {
      const decoded = jwt.verify(
        refreshToken,
        process.env.REFRESH_TOKEN_SECRET
      );
      await Admin.findByIdAndUpdate(decoded.userId, {
        $pull: { refreshTokens: { token: refreshToken } },
      });
    }
    res.clearCookie("accessToken", {
      ...baseCookieOptions,
      path: "/",
    });
    res.clearCookie("refreshToken", {
      ...baseCookieOptions,
      path: "/",
    });
    return res
      .status(200)
      .json({ success: true, message: "Logout successful" });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res
        .status(401)
        .json({ success: false, message: "Refresh token is required" });
    }
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (err) {
      return res
        .status(401)
        .json({ success: false, message: "Expired refresh token" });
    }
    const admin = await Admin.findById(decoded.userId);
    if (!admin || !admin.refreshTokens.find((t) => t.token === refreshToken)) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid refresh token" });
    }
    const accessToken = jwt.sign(
      { userId: admin._id },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "15m" }
    );
    res.cookie("accessToken", accessToken, {
      ...baseCookieOptions,
      maxAge: 15 * 60 * 1000,
    });
    return res
      .status(200)
      .json({ success: true, message: "Token refreshed successfully" });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const meetLinkSubmission = async (req, res) => {
  try {
    const { meetLink } = req.body;
    if (!meetLink || meetLink.trim().length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Meet link is required" });
    }
    const admin = req.user;
    admin.meetLink = meetLink;
    await admin.save();
    return res
      .status(200)
      .json({ success: true, message: "Meet link submission successful" });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const createSlot = async (req, res) => {
  try {
    const { round, dateTime } = req.body;
    if (!round || ![1, 2, 3].includes(round)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or missing round number" });
    }
    if (!dateTime) {
      return res
        .status(400)
        .json({ success: false, message: "Date and time are required" });
    }
    let dateTimeIST = moment.tz(dateTime, "Asia/Kolkata").toDate();
    const newSlot = new Slot({
      round,
      time: dateTimeIST,
    });
    await newSlot.save();
    return res.status(201).json({
      success: true,
      message: "Slot creation successful",
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const fetchAllSlots = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["pending", "ongoing"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid slot status",
      });
    }
    const filter = {
      ...(status === "pending" && {
        status: "pending",
        isReady: true,
        $or: [{ meetLink: null }, { meetLink: { $exists: false } }],
      }),
      ...(status === "ongoing" && {
        status: "pending",
        isReady: true,
        meetLink: { $exists: true, $ne: null },
      }),
    };
    const slots = await Slot.find(filter).populate("users").populate("admins");
    return res.status(200).json({
      success: true,
      data: slots,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

export const takeSlot = async (req, res) => {
  const { slotId } = req.params;
  const admin = req.user;
  if (!mongoose.Types.ObjectId.isValid(slotId)) {
    return res.status(400).json({ success: false, message: "Invalid slot ID" });
  }
  if (!admin.meetLink) {
    return res.status(400).json({
      success: false,
      message: "Meet link not found in admin profile",
    });
  }
  try {
    const slot = await Slot.findOneAndUpdate(
      { _id: slotId, reviewer: null },
      {
        reviewer: admin._id,
        meetLink: admin.meetLink,
        $addToSet: { admins: admin._id },
      },
      { new: true }
    )
      .populate("users", "name email currentRound round0 rounds")
      .populate("admins", "name")
      .populate("reviewer", "name");
    if (!slot) {
      return res.status(404).json({
        success: false,
        message: "Slot not found or already has a reviewer assigned",
      });
    }
    const userEmails = slot.users.map((user) => user.email);
    const subject = "IEEE-VIT Interview";
    const message = `<div>Dear ${slot.users[0].name},<br><br>

Kindly join the below meet for your scheduled interview<br><br>
${slot.meetLink}<br><br>
Good luck 
<br><br>
Regards,<br>
IEEE-VIT</div>`;
    userEmails.forEach((email) => sendMail(email, subject, message));
    return res.status(200).json({
      success: true,
      message: "Reviewer assigned successfully and email sent",
      data: slot,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const joinSlot = async (req, res) => {
  const { slotId } = req.params;
  const admin = req.user;
  if (!mongoose.Types.ObjectId.isValid(slotId)) {
    return res.status(400).json({ success: false, message: "Invalid slot ID" });
  }
  try {
    const slot = await Slot.findById(slotId)
      .populate("users", "name email currentRound round0 rounds")
      .populate("admins", "name")
      .populate("reviewer", "name");
    if (!slot) {
      return res
        .status(404)
        .json({ success: false, message: "Slot not found" });
    }
    if (!slot.reviewer) {
      return res.status(400).json({
        success: false,
        message: "Slot does not have a reviewer yet",
      });
    }
    const isAdminAlreadyAssigned = slot.admins.some((adminId) =>
      adminId.equals(admin._id)
    );
    if (!isAdminAlreadyAssigned) {
      slot.admins.push(admin._id);
      await slot.save();
    }
    return res.status(200).json({
      success: true,
      message: isAdminAlreadyAssigned
        ? "Admin is already assigned to this slot"
        : "Admin added to the slot successfully",
      data: slot,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const reviewSlots = async (req, res) => {
  const admin = req.user;
  try {
    const slots = await Slot.find({ reviewer: admin._id })
      .populate("users", "name round0 rounds")
      .lean();
    const filteredSlots = slots.filter((slot) => {
      return slot.users?.some((user) => {
        const rounds = user.rounds || {};
        if (slot.round === 1) return rounds.round1?.status === "pending";
        if (slot.round === 3) return rounds.round3?.status === "pending";
        return false;
      });
    });
    return res.status(200).json({
      success: true,
      message: "Slots pending review found",
      data: filteredSlots.map((slot) => ({
        _id: slot._id,
        round: slot.round,
        time: slot.time,
        users:
          slot.users?.map((user) => ({
            _id: user._id,
            name: user.name,
            round0: user.round0,
            rounds: user.rounds,
          })) || [],
        reviewer: slot.reviewer,
        status: slot.status,
      })),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const reviewSubmission = async (req, res) => {
  const { slotId, userId } = req.params;
  const {
    techStack,
    technicalSkills,
    communicationSkills,
    problemSolving,
    domainKnowledge,
    interestToLearn,
    managementSkills,
    overallRating,
    additionalFeedback,
    groupDiscussion,
    communication,
    leadership,
    criticalThinking,
    teamwork,
    relevancy,
    taskTitle,
    taskDescription,
    taskDeadline,
    projectPerformance,
    teamworkAbilities,
  } = req.body;
  if (
    !mongoose.Types.ObjectId.isValid(slotId) ||
    !mongoose.Types.ObjectId.isValid(userId)
  ) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid slot ID or user ID" });
  }
  try {
    const slot = await Slot.findById(slotId).populate("users", "_id");
    if (!slot) {
      return res
        .status(404)
        .json({ success: false, message: "Slot not found" });
    }
    const userExists = slot.users.some(
      (user) => user._id.toString() === userId
    );
    if (!userExists) {
      return res
        .status(403)
        .json({ success: false, message: "User is not part of this slot" });
    }
    const updateData = {};
    // Round 1 Reviews
    if (slot.round === 1) {
      updateData["rounds.round1.techStack"] = techStack || null;
      updateData["rounds.round1.technicalSkills"] = technicalSkills || null;
      updateData["rounds.round1.communicationSkills"] =
        communicationSkills || null;
      updateData["rounds.round1.problemSolving"] = problemSolving || null;
      updateData["rounds.round1.domainKnowledge"] = domainKnowledge || null;
      updateData["rounds.round1.interestToLearn"] = interestToLearn || null;
      updateData["rounds.round1.managementSkills"] = managementSkills || null;
      updateData["rounds.round1.overallRating"] = overallRating || null;
      updateData["rounds.round1.additionalFeedback"] =
        additionalFeedback || null;
      updateData["rounds.round1.groupDiscussion"] = groupDiscussion || null;
      updateData["rounds.round1.communication"] = communication || null;
      updateData["rounds.round1.leadership"] = leadership || null;
      updateData["rounds.round1.criticalThinking"] = criticalThinking || null;
      updateData["rounds.round1.teamwork"] = teamwork || null;
      updateData["rounds.round1.relevancy"] = relevancy || null;
      updateData["rounds.round1.status"] = "completed";
      if (!taskTitle || !taskDescription || !taskDeadline) {
        return res.status(400).json({
          success: false,
          message:
            "All task fields (title, description, deadline) are required",
        });
      }
      const taskDeadlineIST = moment.tz(taskDeadline, "Asia/Kolkata").toDate();
      updateData["rounds.round2.taskTitle"] = taskTitle;
      updateData["rounds.round2.taskDescription"] = taskDescription;
      updateData["rounds.round2.taskDeadline"] = taskDeadlineIST;
      updateData["rounds.round2.status"] = "pending";
    } else if (slot.round === 3) {
      updateData["rounds.round3.technicalSkills"] = technicalSkills || null;
      updateData["rounds.round3.communicationSkills"] =
        communicationSkills || null;
      updateData["rounds.round3.teamworkAbilities"] = teamworkAbilities || null;
      updateData["rounds.round3.projectPerformance"] =
        projectPerformance || null;
      updateData["rounds.round3.status"] = "completed";
    }
    const updateQuery = { $set: updateData };
    if (slot.round === 1) {
      updateQuery.$inc = { currentRound: 1 };
    }
    await User.updateOne({ _id: userId }, updateQuery);
    slot.status = "completed";
    await slot.save();
    return res.status(200).json({
      success: true,
      message: `Review submission successful for Round ${slot.round}`,
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

export const round0Elimination = async (req, res) => {
  try {
    const result = await User.updateMany(
      { isFresher: false },
      { $set: { isEliminated: true } }
    );
    return res.status(200).json({
      success: true,
      message: "Round 0 elimination successful",
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const round1Elimination = async (req, res) => {
  try {
    const result = await User.updateMany(
      { "rounds.round1.taskSubmitted": false },
      { $set: { isEliminated: true } }
    );
    return res.status(200).json({
      success: true,
      message: "Round 1 elimination successful",
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

export const round2Elimination = async (req, res) => {
  try {
    const result = await User.updateMany(
      { "rounds.round2.taskSubmitted": false },
      { $set: { isEliminated: true } }
    );
    return res.status(200).json({
      success: true,
      message: "Round 2 elimination successful",
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
