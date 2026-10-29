import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  socketId: { type: String, required: true, unique: true },
  name: { type: String, required: true, maxlength: 24 },
  // GeoJSON coordinates are [longitude, latitude]. We map one canvas pixel to one metre,
  // then convert metres to degrees so coordinates stay valid GeoJSON values.
  location: {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: { type: [Number], required: true }
  },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now }
});
userSchema.index({ location: '2dsphere' });
export default mongoose.model('User', userSchema);
