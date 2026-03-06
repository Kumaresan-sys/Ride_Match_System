// GoApp Driver Incentive Service
//
// Admin creates incentive tasks (quests). Drivers complete them to earn bonuses.
//
// Incentive Types:
//   - trip_count    : Complete N trips in a time window
//   - earnings      : Earn ₹X in a time window
//   - streak        : Complete N consecutive trips without cancellation
//   - peak_hour     : Complete N trips during peak hours
//   - area_bonus    : Complete N trips from a specific zone/area
//   - referral      : Refer N new riders or drivers
//   - rating        : Maintain ≥ X average rating for N consecutive trips
//
// Reward Types:
//   - cash    : Credited to driver wallet
//   - coins   : Credited as platform coins
//   - badge   : Achievement badge only

const { logger, eventBus } = require('../utils/logger');

const VALID_INCENTIVE_TYPES = ['trip_count', 'earnings', 'streak', 'peak_hour', 'area_bonus', 'referral', 'rating'];
const VALID_REWARD_TYPES    = ['cash', 'coins', 'badge'];

class IncentiveService {
  constructor() {
    // taskId -> task object
    this.tasks = new Map();
    // `${driverId}:${taskId}` -> progress object
    this.progress = new Map();
  }

  // ─── Admin: Create an incentive task ─────────────────────────────────────
  createTask({
    title,
    description = '',
    type,
    targetValue,
    rewardType = 'cash',
    rewardAmount,
    rewardCoins = 0,
    startDate,
    endDate,
    vehicleType = null,
    cityRegion = null,
    rules = {},
    createdBy = 'admin',
  }) {
    if (!title || !type || !targetValue || !rewardAmount || !startDate || !endDate) {
      return { success: false, error: 'title, type, targetValue, rewardAmount, startDate, endDate are required.' };
    }
    if (!VALID_INCENTIVE_TYPES.includes(type)) {
      return { success: false, error: `Invalid type. Must be one of: ${VALID_INCENTIVE_TYPES.join(', ')}` };
    }
    if (!VALID_REWARD_TYPES.includes(rewardType)) {
      return { success: false, error: `Invalid rewardType. Must be one of: ${VALID_REWARD_TYPES.join(', ')}` };
    }
    if (new Date(startDate) >= new Date(endDate)) {
      return { success: false, error: 'endDate must be after startDate.' };
    }

    const taskId = `TASK-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const task = {
      taskId,
      title,
      description,
      type,
      targetValue: Number(targetValue),
      rewardType,
      rewardAmount: parseFloat(rewardAmount) || 0,
      rewardCoins: parseInt(rewardCoins, 10) || 0,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      vehicleType,
      cityRegion,
      rules,                 // e.g. { minRating: 4.5, minDistance: 2 }
      status: 'active',      // draft | active | paused | completed | expired
      enrolledCount: 0,
      completedCount: 0,
      totalBudgetPaid: 0,
      createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.tasks.set(taskId, task);
    eventBus.publish('incentive_task_created', { taskId, title, type, rewardAmount, rewardType });
    logger.info('INCENTIVE', `Task created: "${title}" [${type}] target=${targetValue} reward=₹${rewardAmount} by ${createdBy}`);

    return { success: true, task };
  }

  // ─── Admin: Update task status ────────────────────────────────────────────
  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found.' };

    const allowed = ['title', 'description', 'status', 'rewardAmount', 'rewardCoins', 'endDate', 'rules'];
    for (const key of allowed) {
      if (updates[key] !== undefined) task[key] = updates[key];
    }
    task.updatedAt = new Date().toISOString();

    return { success: true, task };
  }

  // ─── Admin: Delete task ───────────────────────────────────────────────────
  deleteTask(taskId) {
    if (!this.tasks.has(taskId)) return { success: false, error: 'Task not found.' };
    this.tasks.delete(taskId);
    return { success: true };
  }

  // ─── List tasks ───────────────────────────────────────────────────────────
  listTasks({ activeOnly = false, type = null, limit = 50 } = {}) {
    const now = new Date();
    let tasks = Array.from(this.tasks.values());

    if (activeOnly) {
      tasks = tasks.filter(t => t.status === 'active' && new Date(t.endDate) > now && new Date(t.startDate) <= now);
    }
    if (type) {
      tasks = tasks.filter(t => t.type === type);
    }

    return tasks
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, Math.min(limit, 200));
  }

  // ─── Get a single task ────────────────────────────────────────────────────
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  // ─── Driver enrols in a task ──────────────────────────────────────────────
  enrolDriver(driverId, taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found.' };
    if (task.status !== 'active') return { success: false, error: 'Task is not active.' };
    if (new Date(task.endDate) < new Date()) return { success: false, error: 'Task has expired.' };

    const key = `${driverId}:${taskId}`;
    if (this.progress.has(key)) {
      return { success: false, error: 'Driver already enrolled in this task.' };
    }

    const progress = {
      driverId,
      taskId,
      currentValue: 0,
      targetValue: task.targetValue,
      status: 'in_progress',    // in_progress | completed | failed | expired
      rewardClaimed: false,
      enrolledAt: new Date().toISOString(),
      completedAt: null,
      updatedAt: new Date().toISOString(),
    };

    this.progress.set(key, progress);
    task.enrolledCount++;
    task.updatedAt = new Date().toISOString();

    logger.info('INCENTIVE', `Driver ${driverId} enrolled in task "${task.title}"`);
    return { success: true, progress, task };
  }

  // ─── Update driver progress on a task ────────────────────────────────────
  // Called internally when rides complete, earnings accumulate, etc.
  updateProgress(driverId, taskId, increment = 1) {
    const key = `${driverId}:${taskId}`;
    const progress = this.progress.get(key);
    if (!progress || progress.status !== 'in_progress') return null;

    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'active') return null;
    if (new Date(task.endDate) < new Date()) {
      progress.status = 'expired';
      return progress;
    }

    progress.currentValue = Math.min(progress.currentValue + increment, task.targetValue);
    progress.updatedAt = new Date().toISOString();

    if (progress.currentValue >= task.targetValue) {
      progress.status = 'completed';
      progress.completedAt = new Date().toISOString();
      task.completedCount++;
      task.updatedAt = new Date().toISOString();

      eventBus.publish('incentive_task_completed', {
        driverId,
        taskId,
        taskTitle: task.title,
        rewardType: task.rewardType,
        rewardAmount: task.rewardAmount,
        rewardCoins: task.rewardCoins,
      });
      logger.info('INCENTIVE', `Driver ${driverId} completed task "${task.title}"! Reward: ${task.rewardType} ₹${task.rewardAmount}`);
    }

    return progress;
  }

  // ─── Claim reward (marks as claimed, caller credits wallet) ──────────────
  claimReward(driverId, taskId) {
    const key = `${driverId}:${taskId}`;
    const progress = this.progress.get(key);
    if (!progress) return { success: false, error: 'Progress record not found.' };
    if (progress.status !== 'completed') return { success: false, error: 'Task not yet completed.' };
    if (progress.rewardClaimed) return { success: false, error: 'Reward already claimed.' };

    const task = this.tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found.' };

    progress.rewardClaimed = true;
    progress.claimedAt = new Date().toISOString();
    task.totalBudgetPaid += task.rewardAmount;
    task.updatedAt = new Date().toISOString();

    return {
      success: true,
      rewardType: task.rewardType,
      rewardAmount: task.rewardAmount,
      rewardCoins: task.rewardCoins,
      task: { taskId, title: task.title },
    };
  }

  // ─── Bulk progress update — called on ride complete ───────────────────────
  // Increments trip_count, streak, and peak_hour tasks for a driver
  onRideCompleted(driverId, { fareInr = 0, isPeakHour = false, rating = 5 }) {
    const now = new Date();
    const results = [];

    this.progress.forEach((prog, key) => {
      if (!key.startsWith(`${driverId}:`)) return;
      if (prog.status !== 'in_progress') return;

      const taskId = key.split(':')[1];
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'active') return;
      if (new Date(task.startDate) > now || new Date(task.endDate) < now) return;

      let increment = 0;
      if (task.type === 'trip_count') increment = 1;
      else if (task.type === 'earnings') increment = fareInr;
      else if (task.type === 'streak') increment = 1;
      else if (task.type === 'peak_hour' && isPeakHour) increment = 1;
      else if (task.type === 'rating' && rating >= (task.rules.minRating || 4.0)) increment = 1;

      if (increment > 0) {
        const updated = this.updateProgress(driverId, taskId, increment);
        if (updated) results.push({ taskId, task: task.title, status: updated.status, current: updated.currentValue, target: updated.targetValue });
      }
    });

    return results;
  }

  // ─── Get driver's progress on all enrolled tasks ──────────────────────────
  getDriverProgress(driverId) {
    const result = [];
    this.progress.forEach((prog, key) => {
      if (!key.startsWith(`${driverId}:`)) return;
      const task = this.tasks.get(prog.taskId);
      result.push({
        ...prog,
        task: task ? {
          title: task.title,
          type: task.type,
          rewardType: task.rewardType,
          rewardAmount: task.rewardAmount,
          endDate: task.endDate,
        } : null,
        percentComplete: Math.round((prog.currentValue / prog.targetValue) * 100),
      });
    });
    return result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // ─── Admin: view all driver progress for a task ────────────────────────────
  getTaskLeaderboard(taskId, limit = 20) {
    const result = [];
    this.progress.forEach(prog => {
      if (prog.taskId !== taskId) return;
      result.push(prog);
    });
    return result
      .sort((a, b) => b.currentValue - a.currentValue)
      .slice(0, limit);
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  getStats() {
    const now = new Date();
    const active = Array.from(this.tasks.values()).filter(t => t.status === 'active' && new Date(t.endDate) > now);
    let totalBudget = 0;
    this.tasks.forEach(t => { totalBudget += t.totalBudgetPaid; });
    return {
      totalTasks: this.tasks.size,
      activeTasks: active.length,
      totalEnrollments: this.progress.size,
      totalBudgetPaid: Math.round(totalBudget * 100) / 100,
    };
  }
}

module.exports = new IncentiveService();
