import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { Person } from './';
@Entity({ schema: 'beneficiaries', name: 'person_affiliates' })
export class PersonAffiliate {
  @PrimaryGeneratedColumn()
  id: number;
  @Column()
  type: 'affiliates' | 'persons';
  @Column()
  typeId: number;
  @Column()
  kinshipType: number;
  @Column()
  state: boolean;

  @ManyToOne(() => Person, (person) => person.personAffiliates, { nullable: false })
  person: Person;
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date;
}
